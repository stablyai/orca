import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const SOURCE_PATH = resolve(__dirname, 'ResourceUsageStatusSegment.tsx')

describe('ResourceUsageStatusSegment session polling', () => {
  it('does not poll global terminal sessions while the popover is closed', () => {
    const source = readFileSync(SOURCE_PATH, 'utf8')

    expect(source).not.toContain('installWindowVisibilityInterval')
    expect(source).not.toContain('SESSIONS_POLL_MS')
    expect(source.match(/window\.api\.pty\.listSessions\(\)/g) ?? []).toHaveLength(1)

    const openEffectIndex = source.indexOf('if (!open)')
    const refreshIndex = source.indexOf('void refreshSessions()', openEffectIndex)

    // Why: pty.listSessions() is a global daemon inventory and can pause input
    // with large preserved-session sets. Keep it on explicit Resource Manager use.
    expect(openEffectIndex).toBeGreaterThanOrEqual(0)
    expect(refreshIndex).toBeGreaterThan(openEffectIndex)
  })
})
