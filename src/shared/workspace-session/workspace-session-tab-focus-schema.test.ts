import { describe, expect, it } from 'vitest'
import { parseWorkspaceSession } from './workspace-session-schema'

function sessionWithLastFocusedAt(lastFocusedAt: unknown): Record<string, unknown> {
  return {
    activeRepoId: null,
    activeWorktreeId: null,
    activeTabId: null,
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    unifiedTabs: {
      wt: [
        {
          id: 'tab-1',
          entityId: 'terminal-1',
          groupId: 'group-1',
          worktreeId: 'wt',
          contentType: 'terminal',
          label: 'Terminal',
          customLabel: null,
          color: null,
          sortOrder: 0,
          createdAt: 1,
          lastFocusedAt
        }
      ]
    }
  }
}

describe('workspace session unified-tab focus timestamp', () => {
  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])(
    'drops an invalid lastFocusedAt without dropping its tab (%s)',
    (lastFocusedAt) => {
      const result = parseWorkspaceSession(sessionWithLastFocusedAt(lastFocusedAt))

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.value.unifiedTabs?.wt).toHaveLength(1)
        expect(result.value.unifiedTabs?.wt[0]?.lastFocusedAt).toBeUndefined()
      }
    }
  )
})
