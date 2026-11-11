// What was running in each terminal pane when an Orca Cloud workspace went to sleep. Sleep stops
// the sandbox (a reboot), so a dev server or watcher is silently gone after a wake; the pane says
// so once and offers to rerun the command. Never reruns on its own.
import { useSyncExternalStore } from 'react'

/** A pane's foreground process as seen in its scrollback just before the sleep. */
export type WakeProcessHint = {
  /** The command line that started it, when the prompt line is readable. */
  command: string
}

// A shell prompt line: something short, then a prompt mark, then the typed command.
const PROMPT_LINE = /^(.{0,120}?)(?:\$|#|%|❯|›|>)\s+(\S.*)$/
const BARE_PROMPT = /^(.{0,120}?)(?:\$|#|%|❯|›|>)\s*$/
const MAX_COMMAND_LENGTH = 300

/**
 * The command still running at the end of a terminal tail: the last prompt line with a command,
 * followed by output and no new prompt. Null when the shell was idle at a prompt, or nothing looks
 * like a prompt (we only offer Rerun for a command we can read back exactly).
 */
export function detectForegroundCommand(lines: readonly string[]): WakeProcessHint | null {
  const trimmed = lines.map((line) => line.replace(/\s+$/, ''))
  let last = trimmed.length - 1
  while (last >= 0 && trimmed[last] === '') {
    last--
  }
  if (last < 0) {
    return null
  }
  // Idle at a prompt (with or without a half-typed line): nothing was running.
  if (BARE_PROMPT.test(trimmed[last]!) || PROMPT_LINE.test(trimmed[last]!)) {
    return null
  }
  for (let index = last - 1; index >= 0; index--) {
    const match = PROMPT_LINE.exec(trimmed[index]!)
    if (match) {
      const command = match[2]!.trim()
      if (!command || command.length > MAX_COMMAND_LENGTH) {
        return null
      }
      return { command }
    }
  }
  return null
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

// Keyed by the pane's durable leaf id; cleared once the pane has shown (or dismissed) its line.
const hints = new Map<string, WakeProcessHint>()
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
export function captureWakeProcessHint(leafId: string, lines: readonly string[]): void {
  if (captured.has(leafId)) {
    return
  }
  captured.add(leafId)
  const hasHistory = lines.some((line) => line.trim() !== '')
  if (hasHistory) {
    withHistory.add(leafId)
  }
  const hint = detectForegroundCommand(lines)
  if (hint) {
    hints.set(leafId, hint)
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
  captured.clear()
  withHistory.clear()
  version = 0
}
