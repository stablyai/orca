/* eslint-disable no-control-regex -- terminal snapshots normalize ANSI/control output. */
import type { AutomationRunOutputSnapshot } from '../../../../shared/automations-types'

const MAX_OUTPUT_SNAPSHOT_CHARS = 256 * 1024

const ANSI_PATTERN =
  /[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g
const CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g

export type AutomationRunOutputSnapshotBuffer = {
  append: (chunk: string) => void
  snapshot: () => AutomationRunOutputSnapshot | null
}

function stripTerminalControls(value: string): string {
  return value
    .replace(ANSI_PATTERN, '')
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
      while (totalChars > MAX_OUTPUT_SNAPSHOT_CHARS && chunks.length > 1) {
        totalChars -= chunks.shift()!.length
        truncated = true
      }
      if (totalChars > MAX_OUTPUT_SNAPSHOT_CHARS && chunks.length === 1) {
        chunks[0] = chunks[0].slice(-MAX_OUTPUT_SNAPSHOT_CHARS)
        totalChars = chunks[0].length
        truncated = true
      }
    },
    snapshot() {
      const content = stripTerminalControls(chunks.join('')).trim()
      if (!content) {
        return null
      }
      return {
        format: 'plain_text',
        content,
        capturedAt: Date.now(),
        truncated
      }
    }
  }
}
