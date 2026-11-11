// What was running in each terminal pane when an Orca Cloud workspace went to sleep. Sleep stops
// the sandbox (a reboot), so a dev server or watcher is silently gone after a wake; the pane says
// so once and offers it back. Never reruns or restarts on its own.
import { useSyncExternalStore } from 'react'
import { recognizeAgentLaunchCommand } from '../../../../shared/agent-launch/startup/agent-command-line-intent'
import type { HostAgentSignInAgent } from '../../../../shared/host-agent-sign-in-status'

/** A shell command still running when the workspace went to sleep, read back from its prompt line. */
export type WakeShellCommand = { command: string }

/**
 * What the woke-up strip offers: Rerun for a plain shell command, or Restart for an agent pane
 * (through the agent restart path; never by retyping its launch line, which sources a one-shot
 * launch script that resumes a conversation the reboot may have lost).
 */
export type WakeProcessHint = WakeShellCommand | { restartAgent: HostAgentSignInAgent }

/** What the pane itself knows at capture time, beyond its text. */
export type WakePaneFacts = {
  /** The pane's agent, from its agent status row. */
  agentType?: string | null
  /** A full-screen app (vim, htop, an alternate-screen TUI) owned the pane. */
  alternateScreen?: boolean
  /**
   * The cursor sat below the last line of text: Enter was pressed on that line. Tells a silent
   * running command (`sleep 900`, its prompt line the last text) from a half-typed one.
   */
  cursorBelowText?: boolean
}

// A shell prompt line: something short, then a prompt mark, then the typed command.
const PROMPT_LINE = /^(.{0,120}?)(\$|#|%|❯|›|>)\s+(\S.*)$/
const BARE_PROMPT = /^(.{0,120}?)(\$|#|%|❯|›|>)\s*$/
// Marks that also open agent TUI input rows ("> Try …", "› Ask …"); a shell uses them only after
// some prompt text (fish's "user@host ~>"), never alone at the start of a line.
const TUI_INPUT_MARKS = new Set(['>', '›'])
// Box-drawing rows: a TUI's frame (an agent's input box, a pager, a dashboard), never a shell prompt.
const TUI_CHROME = /[\u2500-\u257f]/
// Orca's own agent launch line (". /tmp/orca-launch-<hex>.sh"): the script deletes itself after it
// runs, so it can never be rerun.
const ORCA_LAUNCH_SCRIPT = /orca-launch-[\w-]*\.sh/
const MAX_COMMAND_LENGTH = 300

function isPromptMark(prefix: string, mark: string): boolean {
  return !TUI_INPUT_MARKS.has(mark) || /\S$/.test(prefix)
}

function promptCommand(line: string): string | null {
  const match = PROMPT_LINE.exec(line)
  return match && isPromptMark(match[1]!, match[2]!) ? match[3]!.trim() : null
}

function isIdlePrompt(line: string): boolean {
  const bare = BARE_PROMPT.exec(line)
  return (bare !== null && isPromptMark(bare[1]!, bare[2]!)) || promptCommand(line) !== null
}

/**
 * The command still running at the end of a terminal tail: the last prompt line with a command,
 * followed by output and no new prompt. Null when the shell was idle at a prompt, nothing looks
 * like a prompt, or the pane shows a TUI (an agent's input box is typed text, not a command): we
 * only offer Rerun for a shell command we can read back exactly (JA-15).
 */
export function detectForegroundCommand(
  lines: readonly string[],
  options: { cursorBelowText?: boolean | undefined } = {}
): WakeShellCommand | null {
  const trimmed = lines.map((line) => line.replace(/\s+$/, ''))
  const last = lastTextRow(trimmed)
  if (last < 0) {
    return null
  }
  if (isIdlePrompt(trimmed[last]!)) {
    // A prompt line with a command and the cursor already below it: submitted, and still running
    // without output so far (WAKE-RERUN). Otherwise idle, or a half-typed line: nothing ran.
    const silent = options.cursorBelowText ? promptCommand(trimmed[last]!) : null
    return silent === null || TUI_CHROME.test(trimmed[last]!) ? null : rerunnable(silent)
  }
  for (let index = last; index >= 0; index--) {
    const line = trimmed[index]!
    if (TUI_CHROME.test(line)) {
      return null
    }
    const command = index < last ? promptCommand(line) : null
    if (command !== null) {
      return rerunnable(command)
    }
  }
  return null
}

/**
 * The command as a Rerun, or null. An agent launched from the shell owns the screen below it:
 * rerunning it is not "restart the dev server", and what it drew is not shell output.
 */
function rerunnable(command: string): WakeShellCommand | null {
  if (
    !command ||
    command.length > MAX_COMMAND_LENGTH ||
    ORCA_LAUNCH_SCRIPT.test(command) ||
    recognizeAgentLaunchCommand(command)
  ) {
    return null
  }
  return { command }
}

/** The tail ends at an idle shell prompt: nothing (no agent, no process) is running in the pane. */
export function endsAtShellPrompt(lines: readonly string[]): boolean {
  const last = lastTextRow(lines)
  return last >= 0 && isIdlePrompt(lines[last]!.replace(/\s+$/, ''))
}

function lastTextRow(lines: readonly string[]): number {
  let last = lines.length - 1
  while (last >= 0 && lines[last]!.trim() === '') {
    last--
  }
  return last
}

/**
 * The pane's hint: Rerun for a readable shell command; else, for a Claude or Codex pane that was
 * not sitting at a shell prompt, Restart that agent (interim until agents relaunch themselves on
 * wake); else nothing (an alternate-screen app, an idle shell, or nothing readable).
 */
export function wakeHintForPane(
  lines: readonly string[],
  facts: WakePaneFacts = {}
): WakeProcessHint | null {
  const shell = facts.alternateScreen
    ? null
    : detectForegroundCommand(lines, { cursorBelowText: facts.cursorBelowText })
  if (shell) {
    return shell
  }
  const agent = facts.agentType
  if (agent !== 'claude' && agent !== 'codex') {
    return null
  }
  // An agent row outlives the agent: back at a shell prompt, nothing of it was running.
  return lastTextRow(lines) >= 0 && !endsAtShellPrompt(lines) ? { restartAgent: agent } : null
}

type TailSource = {
  buffer: {
    active: {
      length: number
      getLine: (index: number) => { translateToString: (trimRight?: boolean) => string } | undefined
    }
  }
}

/** The last `count` lines of an xterm buffer as text. */
export function readTerminalTail(terminal: TailSource, count = 200): string[] {
  const buffer = terminal.buffer.active
  const start = Math.max(0, buffer.length - count)
  const lines: string[] = []
  for (let index = start; index < buffer.length; index++) {
    lines.push(buffer.getLine(index)?.translateToString(true) ?? '')
  }
  return lines
}

type CursorSource = TailSource & {
  buffer: TailSource['buffer'] & {
    active: TailSource['buffer']['active'] & { baseY: number; cursorY: number }
  }
}

/** The cursor is on a row below the last line of text in the tail `readTerminalTail` reads. */
export function cursorBelowLastText(terminal: CursorSource, count = 200): boolean {
  const buffer = terminal.buffer.active
  const start = Math.max(0, buffer.length - count)
  const last = lastTextRow(readTerminalTail(terminal, count))
  return last >= 0 && buffer.baseY + buffer.cursorY > start + last
}

type ViewportSource = TailSource & {
  rows: number
  buffer: TailSource['buffer'] & { active: TailSource['buffer']['active'] & { viewportY: number } }
}

/**
 * Rows from the top of the visible screen through the last one with text, or null when the text
 * reaches the last row (the history fills the pane) or the screen is empty.
 */
export function historyEndRow(terminal: ViewportSource): number | null {
  const { viewportY } = terminal.buffer.active
  for (let row = terminal.rows - 1; row >= 0; row--) {
    const text = terminal.buffer.active.getLine(viewportY + row)?.translateToString(true) ?? ''
    if (text.trim() !== '') {
      return row === terminal.rows - 1 ? null : row + 1
    }
  }
  return null
}

/** `historyEndRow` in px from the top of `container`, measured from the rendered xterm screen. */
export function historyEndOffsetPx(
  terminal: ViewportSource & { element?: HTMLElement | undefined },
  container: HTMLElement
): number | null {
  const rows = historyEndRow(terminal)
  const screen = terminal.element?.querySelector<HTMLElement>('.xterm-screen')
  if (rows === null || !screen || terminal.rows <= 0) {
    return null
  }
  const rowHeight = screen.clientHeight / terminal.rows
  const top = screen.getBoundingClientRect().top - container.getBoundingClientRect().top
  return Math.round(top + rows * rowHeight + 4)
}

// Keyed by the pane's durable leaf id; cleared once the pane has shown (or dismissed) its line.
const hints = new Map<string, WakeProcessHint>()
// When each hinted pane was looked at (asleep): agent evidence newer than this came after the sleep.
const capturedAt = new Map<string, number>()
// Panes already looked at in this sleep: the first look sees the pre-sleep scrollback.
const captured = new Set<string>()
// Panes whose pre-sleep scrollback had any text: greyed while waking until the new terminal attaches.
const withHistory = new Set<string>()
const listeners = new Set<() => void>()
let version = 0

function emit(): void {
  version++
  for (const listener of listeners) {
    listener()
  }
}

/** Called once per pane per sleep, while the pre-sleep scrollback is still in the pane. */
export function captureWakeProcessHint(
  leafId: string,
  lines: readonly string[],
  facts: WakePaneFacts = {},
  now = Date.now()
): void {
  if (captured.has(leafId)) {
    return
  }
  captured.add(leafId)
  const hasHistory = lines.some((line) => line.trim() !== '')
  if (hasHistory) {
    withHistory.add(leafId)
  }
  const hint = wakeHintForPane(lines, facts)
  if (hint) {
    hints.set(leafId, hint)
    capturedAt.set(leafId, now)
  }
  if (hasHistory || hint) {
    emit()
  }
}

/** The workspace is up again: the next sleep looks at the panes afresh. */
export function resetWakeProcessCapture(leafIds: readonly string[]): void {
  for (const id of leafIds) {
    captured.delete(id)
    withHistory.delete(id)
  }
}

/** The pane still shows output from before the sleep (looked at during this sleep, with any text). */
export function wakeShowsStaleHistory(leafId: string): boolean {
  return withHistory.has(leafId)
}

export function dismissWakeProcessHint(leafId: string): void {
  if (hints.delete(leafId)) {
    emit()
  }
}

export function getWakeProcessHint(leafId: string): WakeProcessHint | null {
  return hints.get(leafId) ?? null
}

/** When the pane's hint was captured (while asleep), or null when it has none. */
export function getWakeCaptureTime(leafId: string): number | null {
  return hints.has(leafId) ? (capturedAt.get(leafId) ?? null) : null
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Re-renders when any pane's hint changes. */
export function useWakeProcessHintsVersion(): number {
  return useSyncExternalStore(subscribe, () => version)
}

/** Tests only. */
export function resetWakeProcessHintsForTests(): void {
  hints.clear()
  capturedAt.clear()
  captured.clear()
  withHistory.clear()
  version = 0
}
