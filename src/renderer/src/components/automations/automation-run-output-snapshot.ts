/* eslint-disable no-control-regex -- terminal snapshots normalize ANSI/control output. */
import type { AutomationRunOutputSnapshot } from '../../../../shared/automations-types'

const MAX_OUTPUT_SNAPSHOT_CHARS = 256 * 1024

// Why: Codex/Claude TUIs emit OSC title/progress frames in hidden automation
// PTYs; saved run output should keep command text, not terminal metadata.
const OSC_SEQUENCE_PATTERN = /(?:\u001b\]|\u009d)[\s\S]*?(?:\u0007|\u001b\\|\u009c)/g
const STRING_SEQUENCE_PATTERN =
  /(?:\u001b[P_^X]|\u0090|\u0098|\u009e|\u009f)[\s\S]*?(?:\u001b\\|\u009c)/g
const CSI_SEQUENCE_PATTERN = /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g
const ESCAPE_SEQUENCE_PATTERN = /\u001b[ -/]*[0-~]/g
const CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g

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
  return value
    .replace(OSC_SEQUENCE_PATTERN, '')
    .replace(STRING_SEQUENCE_PATTERN, '')
    .replace(CSI_SEQUENCE_PATTERN, '')
    .replace(ESCAPE_SEQUENCE_PATTERN, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(CONTROL_PATTERN, '')
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
