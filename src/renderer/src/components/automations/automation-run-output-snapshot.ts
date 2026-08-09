import type { AutomationRunOutputSnapshot } from '../../../../shared/automations-types'
import {
  stripAnsiEscapeSequences,
  TERMINAL_CONTROL_CHARACTER_PATTERN
} from '../../../../shared/ansi-escape-sequences'

const MAX_OUTPUT_SNAPSHOT_CHARS = 256 * 1024

export type AutomationRunOutputSnapshotBuffer = {
  append: (chunk: string) => void
  snapshot: () => AutomationRunOutputSnapshot | null
}

export function createAutomationRunOutputSnapshotFromText(
  content: string,
  truncated = false
): AutomationRunOutputSnapshot | null {
  const trimmed = content.trim()
  if (!trimmed) {
    return null
  }
  return {
    format: 'plain_text',
    content: trimmed,
    capturedAt: Date.now(),
    truncated
  }
}

export function selectAutomationRunOutputSnapshot(
  assistantMessage: string | null | undefined,
  terminalSnapshot: AutomationRunOutputSnapshot | null
): AutomationRunOutputSnapshot | null {
  // Why: raw hidden-PTY captures include full-screen TUI redraws; hook
  // transcript text is the user-facing automation result when available.
  return createAutomationRunOutputSnapshotFromText(assistantMessage ?? '') ?? terminalSnapshot
}

function stripTerminalControls(value: string): string {
  return stripAnsiEscapeSequences(value)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(TERMINAL_CONTROL_CHARACTER_PATTERN, '')
}

export function createAutomationRunOutputSnapshotBuffer(): AutomationRunOutputSnapshotBuffer {
  const chunks: string[] = []
  let totalChars = 0
  let truncated = false

  return {
    append(chunk) {
      if (!chunk) {
        return
      }
      chunks.push(chunk)
      totalChars += chunk.length
      let overflowChars = totalChars - MAX_OUTPUT_SNAPSHOT_CHARS
      while (overflowChars > 0 && chunks.length > 0) {
        const firstChunk = chunks[0]
        if (firstChunk.length <= overflowChars) {
          chunks.shift()
          totalChars -= firstChunk.length
          overflowChars -= firstChunk.length
          truncated = true
          continue
        }
        chunks[0] = firstChunk.slice(overflowChars)
        totalChars -= overflowChars
        truncated = true
        overflowChars = 0
      }
    },
    snapshot() {
      const content = stripTerminalControls(chunks.join('')).trim()
      return createAutomationRunOutputSnapshotFromText(content, truncated)
    }
  }
}
