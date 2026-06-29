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

type ImeEventLogEntry = {
  type: string
  at: number
  data: string | null
  inputType: string | null
  key: string | null
  code: string | null
  keyCode: number | null
  isComposing: boolean | null
  value: string
  selectionStart: number | null
  selectionEnd: number | null
  textareaRect: { left: number; top: number; width: number; height: number }
  cursorX: number | null
  cursorY: number | null
}

type TerminalPromptState = {
  model: string
  cursor: number
  submitted: string[]
}

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

const CODEX_READY_RE = /Ask Codex|OpenAI/i
const CODEX_TRUST_PROMPT_RE = /Do you trust|trust this folder|Trust this/i
const CODEX_UPDATE_PROMPT_RE = /update available|install update|Skip for now/i

function terminalImeHarnessScript(runId: string): string {
  return `
const readline = require('node:readline')

const runId = ${JSON.stringify(runId)}
let model = ''
let cursor = 0
const submitted = []

function charWidth(ch) {
  const code = ch.codePointAt(0) || 0
  return code >= 0x1100 ? 2 : 1
}

function displayColumns(value) {
  return Array.from(value).reduce((total, ch) => total + charWidth(ch), 0)
}

function emitState(reason) {
  process.stdout.write('\\r\\x1b[2K${PROMPT}' + model)
  const suffixColumns = displayColumns(Array.from(model).slice(cursor).join(''))
  if (suffixColumns > 0) {
    process.stdout.write('\\x1b[' + suffixColumns + 'D')
  }
  process.stdout.write('\\x1b]1337;OrcaImeState=' + Buffer.from(JSON.stringify({
    reason,
    model,
    cursor,
    submitted
  })).toString('base64') + '\\x07')
}

function insertText(text) {
  const chars = Array.from(model)
  chars.splice(cursor, 0, ...Array.from(text))
  model = chars.join('')
  cursor += Array.from(text).length
}

function removeBeforeCursor() {
  if (cursor <= 0) return
  const chars = Array.from(model)
  chars.splice(cursor - 1, 1)
  model = chars.join('')
  cursor -= 1
}

function handleData(data) {
  let index = 0
  while (index < data.length) {
    if (data.startsWith('\\x1b[D', index)) {
      cursor = Math.max(0, cursor - 1)
      index += 3
      continue
    }
    if (data.startsWith('\\x1b[C', index)) {
      cursor = Math.min(Array.from(model).length, cursor + 1)
      index += 3
      continue
    }
    const ch = data[index]
    if (ch === '\\u0003') {
      process.exit(0)
    }
    if (ch === '\\r' || ch === '\\n') {
      submitted.push(model)
      process.stdout.write('\\r\\x1b[2K[SUBMITTED_JSON_' + runId + ']' + JSON.stringify(model) + '\\n')
      model = ''
      cursor = 0
      index += 1
      emitState('submit')
      continue
    }
    if (ch === '\\u007f' || ch === '\\b') {
      removeBeforeCursor()
      index += 1
      continue
    }
    insertText(ch)
    index += ch.length
  }
  emitState('input')
}

readline.emitKeypressEvents(process.stdin)
if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.setEncoding('utf8')
process.stdout.write('IME_HARNESS_READY_' + runId + '\\n')
emitState('ready')
process.stdin.on('data', handleData)
`
}

async function installImeEventProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const targetWindow = window as unknown as { __orcaImeEventLog?: ImeEventLogEntry[] }
    targetWindow.__orcaImeEventLog = []
    const state = window.__store?.getState()
    const worktreeId = state?.activeWorktreeId
    const tabId =
      state?.activeTabType === 'terminal'
        ? state.activeTabId
        : worktreeId
          ? (state?.activeTabIdByWorktree?.[worktreeId] ?? null)
          : null
    const manager = tabId ? window.__paneManagers?.get(tabId) : null
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    const textarea = pane?.container.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')
    if (!pane || !textarea) {
      throw new Error('No active terminal helper textarea')
    }
    const record = (event: Event): void => {
      const input = event instanceof InputEvent ? event : null
      const composition = event instanceof CompositionEvent ? event : null
      const keyboard = event instanceof KeyboardEvent ? event : null
      const rect = textarea.getBoundingClientRect()
      targetWindow.__orcaImeEventLog!.push({
        type: event.type,
        at: performance.now(),
        data: input?.data ?? composition?.data ?? null,
        inputType: input?.inputType ?? null,
        key: keyboard?.key ?? null,
        code: keyboard?.code ?? null,
        keyCode: keyboard?.keyCode ?? null,
        isComposing: keyboard?.isComposing ?? input?.isComposing ?? null,
        value: textarea.value,
        selectionStart: textarea.selectionStart,
        selectionEnd: textarea.selectionEnd,
        textareaRect: {
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height
        },
        cursorX: pane.terminal.buffer.active.cursorX,
        cursorY: pane.terminal.buffer.active.cursorY
      })
    }
    for (const type of [
      'compositionstart',
      'compositionupdate',
      'compositionend',
      'beforeinput',
      'input',
      'keydown',
      'keyup'
    ]) {
      textarea.addEventListener(type, record, true)
    }
  })
}

async function readImeEventLog(page: Page): Promise<ImeEventLogEntry[]> {
  return page.evaluate(() => {
    const targetWindow = window as unknown as { __orcaImeEventLog?: ImeEventLogEntry[] }
    return targetWindow.__orcaImeEventLog ?? []
  })
}

async function readPromptState(page: Page): Promise<TerminalPromptState | null> {
  const content = stripTerminalControls(await getTerminalContent(page, 20_000))
  const matches = [...content.matchAll(/\[SUBMITTED_JSON_[^\]]+\]("[\s\S]*?")/g)]
  const submitted = matches
    .map((match) => {
      try {
        return JSON.parse(match[1] ?? '""') as string
      } catch {
        return null
      }
    })
    .filter((value): value is string => value !== null)
  const promptIndex = content.lastIndexOf(PROMPT)
  const liveLine =
    promptIndex >= 0 ? (content.slice(promptIndex + PROMPT.length).split(/\r?\n/)[0] ?? '') : ''
  return {
    model: liveLine.trimEnd(),
    cursor: Array.from(liveLine.trimEnd()).length,
    submitted
  }
}

async function attachImeEvidence(
  page: Page,
  testInfo: TestInfo,
  name: string,
  extra: Record<string, unknown> = {}
): Promise<void> {
  const evidence = {
    ...extra,
    terminal: await getTerminalContent(page, 20_000),
    promptState: await readPromptState(page),
    imeEvents: await readImeEventLog(page)
  }
  await testInfo.attach(`${name}.json`, {
    body: `${JSON.stringify(evidence, null, 2)}\n`,
    contentType: 'application/json'
  })
}

async function setImeComposition(
  session: CDPSession,
  text: string,
  selectionStart = Array.from(text).length,
  selectionEnd = Array.from(text).length
): Promise<void> {
  await session.send('Input.imeSetComposition', {
    text,
    selectionStart,
    selectionEnd
  })
}

async function commitImeText(session: CDPSession, text: string): Promise<void> {
  await session.send('Input.insertText', { text })
}

async function dispatchImeProcessKey(session: CDPSession, code: string): Promise<void> {
  // Why: Windows IMEs report pre-edit keystrokes as VK_PROCESSKEY (229).
  // This catches regressions where xterm treats the physical Pinyin key as a
  // normal Latin character before Chromium delivers the composition update.
  await session.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: 'Process',
    code,
    windowsVirtualKeyCode: 229,
    nativeVirtualKeyCode: 229,
    text: '',
    unmodifiedText: ''
  })
  await session.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Process',
    code,
    windowsVirtualKeyCode: 229,
    nativeVirtualKeyCode: 229,
    text: '',
    unmodifiedText: ''
  })
}

async function composeAndCommitChineseText(
  session: CDPSession,
  page: Page,
  preeditFrames: string[],
  committedText: string
): Promise<void> {
  await focusActiveTerminalInput(page)
  for (const frame of preeditFrames) {
    await setImeComposition(session, frame)
    await page.waitForTimeout(80)
  }
  await commitImeText(session, committedText)
  await page.waitForTimeout(150)
}

async function waitForLivePrompt(page: Page, expected: string): Promise<void> {
  await expect
    .poll(async () => (await readPromptState(page))?.model ?? '', {
      timeout: 5_000,
      message: `live prompt did not become ${expected}`
    })
    .toBe(expected)
}

async function waitForCleanTerminalText(
  page: Page,
  pattern: RegExp,
  message: string
): Promise<void> {
  await expect
    .poll(async () => pattern.test(stripTerminalControls(await getTerminalContent(page, 20_000))), {
      timeout: 10_000,
      message
    })
    .toBe(true)
}

async function dismissCodexPromptsIfPresent(page: Page): Promise<void> {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const content = stripTerminalControls(await getTerminalContent(page, 20_000))
    if (CODEX_READY_RE.test(content) && !CODEX_TRUST_PROMPT_RE.test(content)) {
      return
    }
    if (CODEX_TRUST_PROMPT_RE.test(content)) {
      await page.keyboard.press('Enter')
      await page.waitForTimeout(300)
      continue
    }
    if (CODEX_UPDATE_PROMPT_RE.test(content)) {
      await page.keyboard.type('3')
      await page.keyboard.press('Enter')
      await page.waitForTimeout(300)
      continue
    }
    await page.waitForTimeout(250)
  }
}

async function launchCodexTui(page: Page, ptyId: string): Promise<void> {
  await sendToTerminal(
    page,
    ptyId,
    'codex --dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust\r'
  )
  await dismissCodexPromptsIfPresent(page)
  await waitForCleanTerminalText(page, CODEX_READY_RE, 'Codex TUI did not become ready')
  await focusActiveTerminalInput(page)
}

test.describe('Chinese IME terminal chat input repro', () => {
  test('keeps composed Chinese text, cursor movement, and Backspace stable in the agent input surface', async ({
    orcaPage,
    testRepoPath
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)

    const ptyId = await waitForActivePanePtyId(orcaPage)
    const runId = randomUUID()
    const scriptPath = path.join(testRepoPath, `.orca-chinese-ime-harness-${runId}.cjs`)
    writeFileSync(scriptPath, terminalImeHarnessScript(runId))
    const session = await orcaPage.context().newCDPSession(orcaPage)

    try {
      await sendToTerminal(orcaPage, ptyId, `node ${JSON.stringify(scriptPath)}\r`)
      await waitForTerminalOutput(orcaPage, `IME_HARNESS_READY_${runId}`, 10_000, 20_000)
      await focusActiveTerminalInput(orcaPage)
      await installImeEventProbe(orcaPage)

      await dispatchImeProcessKey(session, 'KeyN')
      await composeAndCommitChineseText(session, orcaPage, ['n', 'ni', '你', '你好'], '你好')
      await waitForLivePrompt(orcaPage, '你好')
      await attachImeEvidence(orcaPage, testInfo, 'after-compose-hello')
      await orcaPage.keyboard.press('Enter')
      await expect
        .poll(async () => (await readPromptState(orcaPage))?.submitted.at(-1) ?? null, {
          timeout: 5_000,
          message: 'first submitted prompt did not match the composed Chinese text'
        })
        .toBe('你好')

      await commitImeText(session, '一二三四五六七八九十')
      await waitForLivePrompt(orcaPage, '一二三四五六七八九十')
      for (let index = 0; index < 5; index += 1) {
        await orcaPage.keyboard.press('ArrowLeft')
      }
      await dispatchImeProcessKey(session, 'KeyZ')
      await composeAndCommitChineseText(session, orcaPage, ['z', 'zh', '中'], '中')
      await waitForLivePrompt(orcaPage, '一二三四五中六七八九十')
      await attachImeEvidence(orcaPage, testInfo, 'after-middle-insert')

      await setImeComposition(session, 'x')
      await orcaPage.keyboard.press('Backspace')
      await waitForLivePrompt(orcaPage, '一二三四五中六七八九十')
      await setImeComposition(session, '')
      await commitImeText(session, '')

      await orcaPage.keyboard.press('Backspace')
      await waitForLivePrompt(orcaPage, '一二三四五六七八九十')
      await attachImeEvidence(orcaPage, testInfo, 'after-single-backspace')

      await orcaPage.keyboard.press('Enter')
      await expect
        .poll(async () => (await readPromptState(orcaPage))?.submitted.at(-1) ?? null, {
          timeout: 5_000,
          message: 'second submitted prompt did not match the visible Chinese text'
        })
        .toBe('一二三四五六七八九十')

      const log = await readImeEventLog(orcaPage)
      expect(
        log.some((entry) => entry.type === 'compositionstart'),
        'CDP IME path should exercise Chromium/xterm composition events'
      ).toBe(true)
      expect(
        log.some((entry) => entry.type === 'keydown' && entry.key === 'Process'),
        'Windows-style IME process keys should be observable in the event trace'
      ).toBe(true)
      expect(
        log.filter((entry) => entry.type === 'keydown' && entry.key === 'Backspace').length,
        'Backspace should be observable for both the composition and single-delete assertions'
      ).toBe(2)
    } finally {
      await attachImeEvidence(orcaPage, testInfo, 'final-ime-evidence').catch(() => undefined)
      await session.detach().catch(() => undefined)
      await sendToTerminal(orcaPage, ptyId, '\x03').catch(() => undefined)
      rmSync(scriptPath, { force: true })
    }
  })

  test('keeps composed Chinese text stable in the real Codex TUI input @real-codex-ime', async ({
    orcaPage
  }, testInfo) => {
    test.skip(
      process.env.ORCA_E2E_REAL_CODEX_IME !== '1',
      'Set ORCA_E2E_REAL_CODEX_IME=1 to exercise the locally installed Codex TUI'
    )

    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)

    const ptyId = await waitForActivePanePtyId(orcaPage)
    const session = await orcaPage.context().newCDPSession(orcaPage)

    try {
      await launchCodexTui(orcaPage, ptyId)
      await installImeEventProbe(orcaPage)

      await dispatchImeProcessKey(session, 'KeyN')
      await composeAndCommitChineseText(session, orcaPage, ['n', 'ni', '你', '你好'], '你好')
      await waitForCleanTerminalText(orcaPage, /你好/, 'Codex input did not show composed Chinese')
      await attachImeEvidence(orcaPage, testInfo, 'codex-after-compose-hello', {
        cleanTerminal: stripTerminalControls(await getTerminalContent(orcaPage, 20_000))
      })

      await dispatchImeProcessKey(session, 'KeyZ')
      await composeAndCommitChineseText(session, orcaPage, ['z', 'zh', '中'], '中')
      await waitForCleanTerminalText(
        orcaPage,
        /你好中/,
        'Codex input did not keep previously composed text before middle-edit checks'
      )

      await orcaPage.keyboard.press('ArrowLeft')
      await setImeComposition(session, 'x')
      await orcaPage.keyboard.press('Backspace')
      await waitForCleanTerminalText(
        orcaPage,
        /你好中/,
        'Backspace during Codex composition removed committed Chinese text'
      )
      await setImeComposition(session, '')
      await commitImeText(session, '')

      await attachImeEvidence(orcaPage, testInfo, 'codex-after-composition-backspace', {
        cleanTerminal: stripTerminalControls(await getTerminalContent(orcaPage, 20_000))
      })

      const cleanTerminal = stripTerminalControls(await getTerminalContent(orcaPage, 20_000))
      expect(
        cleanTerminal,
        'Codex should keep committed Chinese text when Backspace cancels an IME preedit'
      ).toContain('你好中')
      expect(cleanTerminal).not.toMatch(/\bn(?:i)?你好/)
      expect(cleanTerminal).not.toMatch(/\bz(?:h)?中/)
    } finally {
      await attachImeEvidence(orcaPage, testInfo, 'codex-final-ime-evidence', {
        cleanTerminal: stripTerminalControls(await getTerminalContent(orcaPage, 20_000))
      }).catch(() => undefined)
      await session.detach().catch(() => undefined)
      await sendToTerminal(orcaPage, ptyId, '\x03/quit\r').catch(() => undefined)
    }
  })
})
