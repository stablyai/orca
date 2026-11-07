/**
 * Issue #8372 — outdated running CLI count on bottom panel (closed badge).
 *
 * Closed badge uses store-bound PTY IDs only (never daemon listSessions).
 * Open popover uses sessions.length from the live daemon inventory.
 * After killing orphans (or any daemon-only sessions), open is correct while
 * the closed badge can still report dead store bindings. Restart keeps the
 * mismatch if session state rehydrates those PTY IDs.
 *
 * Re-run:
 *   pnpm exec vitest run --config config/vitest.config.ts \
 *     src/renderer/src/components/status-bar/repro-8372-closed-cli-count-stale.test.ts
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createClosedResourceSessionCountSelector } from './resource-session-count-selector'
import type { TerminalTab } from '../../../../shared/types'

function makeTab(id: string, ptyId: string | null): TerminalTab {
  return {
    id,
    ptyId,
    worktreeId: `wt-${id}`,
    title: 'Terminal',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

describe('issue #8372 closed CLI count diverges from live daemon sessions', () => {
  it('closed selector counts bound store PTYs, not live daemon inventory', () => {
    const selectCount = createClosedResourceSessionCountSelector()
    const state = {
      tabsByWorktree: {
        'wt-1': [makeTab('tab-1', 'pty-alive'), makeTab('tab-2', 'pty-dead-orphan-binding')]
      },
      ptyIdsByTabId: {
        'tab-1': ['pty-alive']
      },
      terminalLayoutsByTabId: {},
      workspaceSessionReady: true
    }

    // Store claims 2 bound PTYs (tab.ptyId wake hints + live map).
    expect(selectCount(state)).toBe(2)

    // Live daemon after "clear orphans" only has 1 session — open popover path.
    const liveDaemonSessions = [{ id: 'pty-alive' }]
    const openPopoverCount = liveDaemonSessions.length
    expect(openPopoverCount).toBe(1)
    expect(selectCount(state)).not.toBe(openPopoverCount)
  })

  it('ResourceUsageStatusSegment dual-sources open vs closed counts', () => {
    const source = readFileSync(join(__dirname, 'ResourceUsageStatusSegment.tsx'), 'utf8')
    expect(source).toMatch(/triggerSessionCount = open \? sessions\.length : closedSessionCount/)
    expect(source).toMatch(/createClosedResourceSessionCountSelector/)
    // Closed path intentionally never lists daemon sessions.
    expect(source).toMatch(/closed badge never reintroduces a background global session scan/)
  })

  it('kill-orphan path does not clear store tab/layout PTY bindings', () => {
    const source = readFileSync(join(__dirname, 'ResourceUsageStatusSegment.tsx'), 'utf8')
    // Optimistic local sessions filter + pty.kill only — no store drop of bindings.
    expect(source).toMatch(/handleKillOrphans/)
    expect(source).toMatch(/setSessions\(\(prev\) => prev\.filter/)
    expect(source).not.toMatch(/dropPty|clearPtyBinding|removePtyIdFromTab/)
  })
})
