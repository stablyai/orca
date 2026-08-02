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
let received = ''

function handleData(data) {
  received += data
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
  process.stdout.write('\\r\\x1b[2K[RECEIVED_JSON_' + runId + ']' + JSON.stringify(received) + '\\n')
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

async function readReceived(page: Page): Promise<string | null> {
  const content = stripTerminalControls(await getTerminalContent(page, 20_000))
  const matches = [...content.matchAll(/\[RECEIVED_JSON_[^\]]+\]("[\s\S]*?")/g)]
  const encoded = matches.at(-1)?.[1]
  if (!encoded) {
    return null
  }
  try {
    return JSON.parse(encoded) as string
  } catch {
    return null
  }
}

type ImeKeyEvent = {
  type: string
  key: string
  code: string
  keyCode: number
  isComposing: boolean
  repeat: boolean
  shiftKey: boolean
  ctrlKey: boolean
  timeStamp: number
}

async function installImeKeyEventLog(page: Page): Promise<void> {
  await page.evaluate(() => {
    const target = window as unknown as { __imeKeyEvents: ImeKeyEvent[] }
    target.__imeKeyEvents = []
    const record = (event: KeyboardEvent): void => {
      target.__imeKeyEvents.push({
        type: event.type,
        key: event.key,
        code: event.code,
        keyCode: event.keyCode,
        isComposing: event.isComposing,
        repeat: event.repeat,
        shiftKey: event.shiftKey,
        ctrlKey: event.ctrlKey,
        timeStamp: event.timeStamp
      })
    }
    window.addEventListener('keydown', record, true)
    window.addEventListener('keyup', record, true)
  })
}

async function readImeKeyEventLog(page: Page): Promise<ImeKeyEvent[]> {
  return page.evaluate(
    () => (window as unknown as { __imeKeyEvents?: ImeKeyEvent[] }).__imeKeyEvents ?? []
  )
}

async function attachEvidence(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const evidence = {
    keyEvents: await readImeKeyEventLog(page),
    received: await readReceived(page),
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
async function dispatchCommittingEnterChord(
  session: CDPSession,
  page: Page,
  modifiers: number,
  redispatchedModifiers: number,
  redispatchAfterKeyup: boolean,
  redispatchTimestampOffset = 0
): Promise<void> {
  const timestamp = Date.now() / 1000
  const composingKeydown = session.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: 'Enter',
    code: 'Enter',
    modifiers,
    timestamp,
    windowsVirtualKeyCode: 229,
    nativeVirtualKeyCode: 229,
    text: '',
    unmodifiedText: ''
  })
  const commit = session.send('Input.insertText', { text: '하' })
  const redispatch = () =>
    session.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key: 'Enter',
      code: 'Enter',
      modifiers: redispatchedModifiers,
      timestamp: timestamp + redispatchTimestampOffset,
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
      text: '',
      unmodifiedText: ''
    })
  const balancingKeyup = () =>
    session.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Enter',
      code: 'Enter',
      modifiers: redispatchedModifiers,
      timestamp: timestamp + redispatchTimestampOffset,
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13
    })

  if (!redispatchAfterKeyup) {
    await Promise.all([composingKeydown, commit, redispatch(), balancingKeyup()])
    return
  }
  await Promise.all([composingKeydown, commit, balancingKeyup()])
  await page.waitForTimeout(80)
  await redispatch()
}

type HeldModifier = {
  key: 'Shift' | 'Control'
  code: 'ShiftLeft' | 'ControlLeft'
  keyCode: 16 | 17
  modifiers: number
}

async function dispatchHeldModifier(
  session: CDPSession,
  modifier: HeldModifier,
  type: 'rawKeyDown' | 'keyUp'
): Promise<void> {
  await session.send('Input.dispatchKeyEvent', {
    type,
    key: modifier.key,
    code: modifier.code,
    modifiers: type === 'rawKeyDown' ? modifier.modifiers : 0,
    windowsVirtualKeyCode: modifier.keyCode,
    nativeVirtualKeyCode: modifier.keyCode
  })
}

async function dispatchPlainEnter(session: CDPSession): Promise<void> {
  await session.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13
  })
  await session.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13
  })
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
  modifiers: number
  redispatchedModifiers?: number
  redispatchTimestampOffset?: number
  preHeldModifier?: HeldModifier
  windowsOnly?: boolean
  assertOutcome: (page: Page) => Promise<void>
  expectedAfterPlainEnter: {
    received: string
    submitted: string[]
  }
}

async function assertShiftOutcome(page: Page): Promise<void> {
  await expect
    .poll(() => readReceived(page), {
      timeout: 10_000,
      message: 'PTY bytes must contain committed Hangul before exactly one Shift+Enter chord'
    })
    .toBe('하 하 하\u001b\r')
  await expect
    .poll(async () => (await readSubmitted(page)).at(-1) ?? null, {
      timeout: 10_000,
      message: 'submitted line must contain the full text with the trailing syllable inline'
    })
    .toBe('하 하 하\u001b')
  await page.waitForTimeout(500)
  expect(await readSubmitted(page), 'Shift+Enter must produce exactly one newline').toEqual([
    '하 하 하\u001b'
  ])
}

async function assertCtrlOutcome(page: Page): Promise<void> {
  await expect
    .poll(() => readReceived(page), {
      timeout: 10_000,
      message: 'PTY bytes must contain committed Hangul before exactly one Ctrl+Enter chord'
    })
    .toBe('하 하 하\u001b[13;5u')
  await expect
    .poll(() => readPromptLine(page), {
      timeout: 10_000,
      message: 'prompt must show the committed syllables followed by exactly one CSI-u chord'
    })
    .toBe('하 하 하<ESC>[13;5u')
  await page.waitForTimeout(500)
  expect(await readPromptLine(page), 'Ctrl+Enter must produce exactly one CSI-u chord').toBe(
    '하 하 하<ESC>[13;5u'
  )
  expect(await readSubmitted(page), 'CSI-u must not submit the line').toEqual([])
}

const COMMITTING_ENTER_CHORDS: CommittingEnterChordCase[] = [
  {
    name: 'Shift+Enter',
    slug: 'shift-enter',
    modifiers: 8,
    assertOutcome: assertShiftOutcome,
    expectedAfterPlainEnter: {
      received: '하 하 하\u001b\r\r',
      submitted: ['하 하 하\u001b', '']
    }
  },
  {
    name: 'Ctrl+Enter',
    slug: 'ctrl-enter',
    modifiers: 2,
    assertOutcome: assertCtrlOutcome,
    expectedAfterPlainEnter: {
      received: '하 하 하\u001b[13;5u\r',
      submitted: ['하 하 하\u001b[13;5u']
    }
  },
  {
    name: 'Shift+Enter with modifier-lost redispatch',
    slug: 'shift-enter-bare-redispatch',
    modifiers: 8,
    redispatchedModifiers: 0,
    assertOutcome: assertShiftOutcome,
    expectedAfterPlainEnter: {
      received: '하 하 하\u001b\r\r',
      submitted: ['하 하 하\u001b', '']
    }
  },
  {
    name: 'pre-held Shift+Enter with modifier-lost redispatch',
    slug: 'pre-held-shift-enter-bare-redispatch',
    modifiers: 8,
    redispatchedModifiers: 0,
    redispatchTimestampOffset: 0.01,
    preHeldModifier: { key: 'Shift', code: 'ShiftLeft', keyCode: 16, modifiers: 8 },
    windowsOnly: true,
    assertOutcome: assertShiftOutcome,
    expectedAfterPlainEnter: {
      received: '하 하 하\u001b\r\r',
      submitted: ['하 하 하\u001b', '']
    }
  },
  {
    name: 'pre-held Ctrl+Enter with modifier-lost redispatch',
    slug: 'pre-held-ctrl-enter-bare-redispatch',
    modifiers: 2,
    redispatchedModifiers: 0,
    redispatchTimestampOffset: 0.01,
    preHeldModifier: { key: 'Control', code: 'ControlLeft', keyCode: 17, modifiers: 2 },
    windowsOnly: true,
    assertOutcome: assertCtrlOutcome,
    expectedAfterPlainEnter: {
      received: '하 하 하\u001b[13;5u\r',
      submitted: ['하 하 하\u001b[13;5u']
    }
  }
]

test.describe('Korean IME terminal committing Enter chords', () => {
  test.describe.configure({ mode: 'serial' })
  for (const chord of COMMITTING_ENTER_CHORDS) {
    for (const redispatchAfterKeyup of [false, true]) {
      const order = redispatchAfterKeyup ? 'keyup-before-redispatch' : 'redispatch-before-keyup'
      test(`${chord.name} sends once with ${order}`, async ({
        orcaPage,
        testRepoPath
      }, testInfo) => {
        test.skip(chord.windowsOnly && process.platform !== 'win32', 'Windows IME ownership')
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
          await installImeKeyEventLog(orcaPage)

          // 하 하 하 with the first two syllables committed by Space and the last
          // one left composing, so the Enter chord is the committing keystroke.
          await composeHangulSyllable(session, orcaPage)
          await commitSyllableAndSpace(session, orcaPage)
          await composeHangulSyllable(session, orcaPage)
          await commitSyllableAndSpace(session, orcaPage)
          if (chord.preHeldModifier) {
            await dispatchHeldModifier(session, chord.preHeldModifier, 'rawKeyDown')
          }
          await composeHangulSyllable(session, orcaPage)
          await dispatchCommittingEnterChord(
            session,
            orcaPage,
            chord.modifiers,
            chord.redispatchedModifiers ?? chord.modifiers,
            redispatchAfterKeyup,
            chord.redispatchTimestampOffset
          )
          if (chord.preHeldModifier) {
            await dispatchHeldModifier(session, chord.preHeldModifier, 'keyUp')
          }

          await chord.assertOutcome(orcaPage)
          await dispatchPlainEnter(session)
          await expect
            .poll(() => readReceived(orcaPage), {
              timeout: 10_000,
              message: 'the next physical Enter must not be consumed by stale IME state'
            })
            .toBe(chord.expectedAfterPlainEnter.received)
          expect(await readSubmitted(orcaPage)).toEqual(chord.expectedAfterPlainEnter.submitted)
          await attachEvidence(orcaPage, testInfo, `korean-${chord.slug}-${order}-commit`)
        } finally {
          await attachEvidence(orcaPage, testInfo, `korean-${chord.slug}-${order}-final`).catch(
            () => undefined
          )
          await session.detach().catch(() => undefined)
          await sendToTerminal(orcaPage, ptyId, '\x03').catch(() => undefined)
          rmSync(scriptPath, { force: true })
        }
      })
    }
  }
})
