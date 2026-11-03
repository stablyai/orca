import { describe, it, expect, vi } from 'vitest'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
import { buildHydratedTabState } from './tabs-hydration'

vi.stubGlobal('crypto', { randomUUID: () => `uuid-${Math.random().toString(36).slice(2, 8)}` })

function makeBaseSession(): WorkspaceSessionState {
  return {
    activeRepoId: null,
    activeWorktreeId: null,
    activeTabId: null,
    tabsByWorktree: {},
    terminalLayoutsByTabId: {}
  }
}

describe('buildHydratedTabState – unified format', () => {
  it('collapses tab records that a corrupt session persisted under one id', () => {
    // Editor migration could re-stamp a sibling’s tab ID; duplicate React keys strand ghost rows.
    const duplicateId = 'editor:wt%3A%3Alungfish:env-a:FINAL-REPORT.md'
    const editorTab = (id: string, entityId: string, sortOrder: number) => ({
      id,
      entityId,
      groupId: 'g1',
      worktreeId: 'w1',
      contentType: 'editor' as const,
      label: 'FINAL-REPORT.md',
      customLabel: null,
      color: null,
      sortOrder,
      createdAt: 1
    })
    const session: WorkspaceSessionState = {
      ...makeBaseSession(),
      unifiedTabs: {
        w1: [
          editorTab('t-unique', 'editor:wt%3A%3Alungfish:env-c:FINAL-REPORT.md', 0),
          editorTab(duplicateId, 'editor:wt%3A%3Alungfish:env-b:FINAL-REPORT.md', 1),
          editorTab(duplicateId, 'editor:wt%3A%3Alungfish:env-b:FINAL-REPORT.md', 2)
        ]
      },
      tabGroups: {
        w1: [
          {
            id: 'g1',
            worktreeId: 'w1',
            activeTabId: 't-unique',
            tabOrder: ['t-unique', duplicateId, duplicateId]
          }
        ]
      }
    }

    const result = buildHydratedTabState(session, new Set(['w1']))
    const hydratedIds = result.unifiedTabsByWorktree.w1.map((tab) => tab.id)
    expect(hydratedIds).toEqual(['t-unique', duplicateId])
    // Assert sortOrder too: IDs alone cannot distinguish keeping first versus last duplicate.
    expect(result.unifiedTabsByWorktree.w1.map((tab) => tab.sortOrder)).toEqual([0, 1])
    expect(new Set(hydratedIds).size).toBe(hydratedIds.length)
    expect(result.groupsByWorktree.w1[0].tabOrder).toEqual(['t-unique', duplicateId])
  })
})
