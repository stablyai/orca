import { randomUUID } from 'node:crypto'
import { rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { CDPSession, Page, TestInfo } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  focusActiveTerminalInput,
  getTerminalContent,
  sendToTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'

// Repro for the Shift/Ctrl+Enter Hangul commit race: macOS delivers a
// committing Enter chord TWICE — first as an IME keydown (keyCode 229, isComposing=true),
// then ~2 ms after compositionend as a re-dispatched plain keydown
// (keyCode 13, isComposing=false). The window-level shortcut handler must send
// exactly one newline, and only after the committed syllable has flushed.
// Deferring only the composing keydown is not enough: the re-dispatch would
// still send its newline immediately (ahead of the glyph) and the deferred
// send would then double it.

const PROMPT = '› '

function stripTerminalControls(value: string): string {
  let output = ''
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code === 0x1b) {
      const next = value[index + 1]
      if (next === ']') {
        index += 2
        while (index < value.length) {
          const current = value.charCodeAt(index)
          if (current === 0x07) {
            break
          }
          if (current === 0x1b && value[index + 1] === '\\') {
            index += 1
            break
          }
          index += 1
        }
        continue
      }
      if (next === '[') {
        index += 2
        while (index < value.length && value.charCodeAt(index) < 0x40) {
          index += 1
        }
        continue
      }
      continue
    }
    if ((code >= 0 && code <= 0x08) || (code >= 0x0b && code <= 0x1f) || code === 0x7f) {
      continue
    }
    output += value[index]
  }
  return output
}

function terminalImeHarnessScript(runId: string): string {
  return `
const runId = ${JSON.stringify(runId)}
let model = ''

function handleData(data) {
  for (const ch of data) {
    if (ch === '\\u0003') {
      process.exit(0)
    }
    if (ch === '\\r' || ch === '\\n') {
      process.stdout.write('\\r\\x1b[2K[SUBMITTED_JSON_' + runId + ']' + JSON.stringify(model) + '\\n')
      model = ''
      continue
    }
    if (ch === '\\u007f' || ch === '\\b') {
      model = Array.from(model).slice(0, -1).join('')
      continue
    }
    model += ch
  }
  process.stdout.write('\\r\\x1b[2K${PROMPT}' + model.replace(/\\x1b/g, '<ESC>'))
}

if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.setEncoding('utf8')
process.stdout.write('IME_HARNESS_READY_' + runId + '\\n')
process.stdout.write('${PROMPT}')
process.stdin.on('data', handleData)
`
}

async function readSubmitted(page: Page): Promise<string[]> {
  const content = stripTerminalControls(await getTerminalContent(page, 20_000))
  const matches = [...content.matchAll(/\[SUBMITTED_JSON_[^\]]+\]("[\s\S]*?")/g)]
  return matches
    .map((match) => {
      try {
        return JSON.parse(match[1] ?? '""') as string
      } catch {
        return null
      }
    })
    .filter((value): value is string => value !== null)
}

async function attachEvidence(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const evidence = {
    terminal: await getTerminalContent(page, 20_000),
    submitted: await readSubmitted(page)
  }
  await testInfo.attach(`${name}.json`, {
    body: `${JSON.stringify(evidence, null, 2)}\n`,
    contentType: 'application/json'
  })
}

async function dispatchHangulProcessKey(
  session: CDPSession,
  key: string,
  code: string
): Promise<void> {
  // Why: macOS Hangul jamo keydowns arrive as IME Process keys (keyCode 229)
  // with the jamo in `key`; the release carries the physical keyCode.
  await session.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key,
    code,
    windowsVirtualKeyCode: 229,
    nativeVirtualKeyCode: 229,
    text: '',
    unmodifiedText: ''
  })
  await session.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key,
    code,
    windowsVirtualKeyCode: 229,
    nativeVirtualKeyCode: 229,
    text: '',
    unmodifiedText: ''
  })
}

async function composeHangulSyllable(session: CDPSession, page: Page): Promise<void> {
  await dispatchHangulProcessKey(session, 'ㅎ', 'KeyG')
  await session.send('Input.imeSetComposition', { text: 'ㅎ', selectionStart: 1, selectionEnd: 1 })
  await page.waitForTimeout(60)
  await dispatchHangulProcessKey(session, 'ㅏ', 'KeyK')
  await session.send('Input.imeSetComposition', { text: '하', selectionStart: 1, selectionEnd: 1 })
  await page.waitForTimeout(60)
}

async function commitSyllableAndSpace(session: CDPSession, page: Page): Promise<void> {
  await session.send('Input.insertText', { text: '하' })
  await page.waitForTimeout(60)
  await session.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: ' ',
    code: 'Space',
    windowsVirtualKeyCode: 32,
    nativeVirtualKeyCode: 32,
    text: ' ',
    unmodifiedText: ' '
  })
  await session.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: ' ',
    code: 'Space',
    windowsVirtualKeyCode: 32,
    nativeVirtualKeyCode: 32
  })
  await page.waitForTimeout(60)
}

/**
 * The committing Enter chord as recorded from the real macOS 2-set Korean IME:
 * IME keydown (229) -> commit -> re-dispatched plain keydown (13) -> keyup,
 * delivered in one un-awaited burst. The real IME delivers all of this within
 * the same native key-processing turn, ahead of xterm's setTimeout(0) glyph
 * flush; awaiting each CDP round-trip would let the flush win and hide the
 * race.
 */
async function dispatchCommittingEnterChord(session: CDPSession, modifiers: number): Promise<void> {
  await Promise.all([
    session.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key: 'Enter',
      code: 'Enter',
      modifiers,
      windowsVirtualKeyCode: 229,
      nativeVirtualKeyCode: 229,
      text: '',
      unmodifiedText: ''
    }),
    session.send('Input.insertText', { text: '하' }),
    session.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key: 'Enter',
      code: 'Enter',
      modifiers,
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
      text: '',
      unmodifiedText: ''
    }),
    session.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Enter',
      code: 'Enter',
      modifiers,
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13
    })
  ])
}

async function readPromptLine(page: Page): Promise<string> {
  const content = stripTerminalControls(await getTerminalContent(page, 20_000))
  const promptIndex = content.lastIndexOf(PROMPT)
  if (promptIndex < 0) {
    return ''
  }
  return (content.slice(promptIndex + PROMPT.length).split(/\r?\n/)[0] ?? '').trimEnd()
}

type CommittingEnterChordCase = {
  name: string
  slug: string
  /** CDP modifier bitmask: 8 = Shift, 2 = Ctrl. */
  modifiers: number
  assertOutcome: (page: Page) => Promise<void>
}

const COMMITTING_ENTER_CHORDS: CommittingEnterChordCase[] = [
  {
    name: 'Shift+Enter',
    slug: 'shift-enter',
    modifiers: 8,
    assertOutcome: async (page) => {
      // The harness records the chord's ESC (of ESC CR) as a literal char and
      // CR submits, so the ESC's position inside the submitted string marks
      // exactly where the newline bytes landed.
      await expect
        .poll(async () => (await readSubmitted(page)).at(-1) ?? null, {
          timeout: 10_000,
          message: 'submitted line must contain the full text with the trailing syllable inline'
        })
        .toBe('하 하 하\u001b')
      // Exactly one submission: the re-dispatched keydown must not add a
      // second newline on top of the deferred one.
      await page.waitForTimeout(500)
      expect(
        await readSubmitted(page),
        'the committing Shift+Enter must produce exactly one newline'
      ).toEqual(['하 하 하\u001b'])
    }
  },
  {
    name: 'Ctrl+Enter',
    slug: 'ctrl-enter',
    modifiers: 2,
    assertOutcome: async (page) => {
      // The CSI-u chord (ESC [13;5u) carries no CR, so nothing submits; the
      // harness echoes the model with ESC rendered as <ESC>. The sequence must
      // appear exactly once, after the committed syllables.
      await expect
        .poll(() => readPromptLine(page), {
          timeout: 10_000,
          message: 'prompt must show the committed syllables followed by exactly one CSI-u chord'
        })
        .toBe('하 하 하<ESC>[13;5u')
      await page.waitForTimeout(500)
      expect(
        await readPromptLine(page),
        'the committing Ctrl+Enter must produce exactly one CSI-u chord'
      ).toBe('하 하 하<ESC>[13;5u')
      expect(await readSubmitted(page), 'CSI-u must not submit the line').toEqual([])
    }
  }
]

test.describe('Korean IME terminal committing Enter chords', () => {
  for (const chord of COMMITTING_ENTER_CHORDS) {
    test(`${chord.name} sends exactly one newline chord, after the trailing syllable commits`, async ({
      orcaPage,
      testRepoPath
    }, testInfo) => {
      await waitForSessionReady(orcaPage)
      await waitForActiveWorktree(orcaPage)
      await ensureTerminalVisible(orcaPage)
      await waitForActiveTerminalManager(orcaPage, 30_000)

      const ptyId = await waitForActivePanePtyId(orcaPage)
      const runId = randomUUID()
      const scriptPath = path.join(testRepoPath, `.orca-korean-ime-harness-${runId}.cjs`)
      const session = await orcaPage.context().newCDPSession(orcaPage)

      try {
        writeFileSync(scriptPath, terminalImeHarnessScript(runId))
        await sendToTerminal(orcaPage, ptyId, `node ${JSON.stringify(scriptPath)}\r`)
        await waitForTerminalOutput(orcaPage, `IME_HARNESS_READY_${runId}`, 10_000, 20_000)
        await focusActiveTerminalInput(orcaPage)

        // 하 하 하 with the first two syllables committed by Space and the last
        // one left composing, so the Enter chord is the committing keystroke.
        await composeHangulSyllable(session, orcaPage)
        await commitSyllableAndSpace(session, orcaPage)
        await composeHangulSyllable(session, orcaPage)
        await commitSyllableAndSpace(session, orcaPage)
        await composeHangulSyllable(session, orcaPage)
        await dispatchCommittingEnterChord(session, chord.modifiers)

        await chord.assertOutcome(orcaPage)
        await attachEvidence(orcaPage, testInfo, `korean-${chord.slug}-commit`)
      } finally {
        await attachEvidence(orcaPage, testInfo, `korean-${chord.slug}-final`).catch(
          () => undefined
        )
        await session.detach().catch(() => undefined)
        await sendToTerminal(orcaPage, ptyId, '\x03').catch(() => undefined)
        rmSync(scriptPath, { force: true })
      }
    })
  }
})
