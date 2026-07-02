import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

function readResourceUsageStatusSegmentSource(): string {
  return readFileSync(
    fileURLToPath(new URL('./ResourceUsageStatusSegment.tsx', import.meta.url)),
    'utf8'
  )
}

describe('resource manager session polling', () => {
  it('keeps broad PTY session inventory scoped to the open popover', () => {
    const source = readResourceUsageStatusSegmentSource()
    const pollingSectionStart = source.indexOf(
      '// Poll memory and broad session inventory only while the management popover is open.'
    )
    const pollingSectionEnd = source.indexOf('const repoDisplayNameById')
    expect(pollingSectionStart).toBeGreaterThan(-1)
    expect(pollingSectionEnd).toBeGreaterThan(pollingSectionStart)

    const pollingSection = source.slice(pollingSectionStart, pollingSectionEnd)
    expect(pollingSection).toContain('if (!open || runtimeEnvironmentActive) {')
    expect(pollingSection).not.toContain('installWindowVisibilityInterval({')
    expect(pollingSection).toContain('window.setInterval(() => {\n      void refreshSessions()')
    expect(pollingSection).toContain('}, SESSIONS_POLL_MS)')
    expect(source).toContain('const SESSIONS_POLL_MS')
  })
})
