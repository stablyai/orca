import { describe, expect, it } from 'vitest'
import type { AppState } from '../../store/types'
import { makeState } from '../sync-runtime-graph-test-harness'
import { buildMobileSessionTabSnapshots } from './mobile-session-snapshots'

describe.each(['check-details', 'conflict-review'] as const)('%s mobile publication', (mode) => {
  it.each(['tabless', 'legacy', 'grouped', 'fallback'] as const)(
    'withholds virtual files from %s tab lists and group references',
    (route) => {
      const worktreeId = 'repo::/repo'
      const virtualId = `${worktreeId}::${mode}::check-run:42`
      const virtualFile = {
        id: virtualId,
        filePath: virtualId,
        relativePath: 'e2e / changed e2e specs (1/1)',
        worktreeId,
        language: 'plaintext',
        mode,
        isDirty: false
      }
      const file = {
        id: '/repo/app.ts',
        filePath: '/repo/app.ts',
        relativePath: 'app.ts',
        worktreeId,
        language: 'typescript',
        mode: 'edit' as const,
        isDirty: false
      }
      const tabs: AppState['unifiedTabsByWorktree'][string] = [virtualFile, file].map(
        (entry, index) => ({
          id: `tab-${index}`,
          entityId: entry.id,
          groupId: 'group-1',
          worktreeId,
          contentType: index === 0 && route !== 'fallback' ? mode : 'editor',
          label: entry.relativePath,
          customLabel: null,
          color: null,
          sortOrder: index,
          createdAt: 0
        })
      )
      const state = makeState({
        openFiles: [virtualFile, file],
        tabBarOrderByWorktree: { [worktreeId]: [virtualId, file.id] },
        activeFileIdByWorktree: { [worktreeId]: virtualId },
        activeTabTypeByWorktree: { [worktreeId]: 'editor' },
        activeGroupIdByWorktree: { [worktreeId]: 'group-1' },
        unifiedTabsByWorktree: route === 'tabless' ? {} : { [worktreeId]: tabs },
        groupsByWorktree:
          route === 'tabless' || route === 'legacy'
            ? {}
            : {
                [worktreeId]: [
                  {
                    id: 'group-1',
                    worktreeId,
                    activeTabId: 'tab-0',
                    tabOrder: route === 'fallback' ? [] : ['tab-0', 'tab-1'],
                    recentTabIds: ['tab-1', 'tab-0']
                  }
                ]
              }
      })

      const snapshot = buildMobileSessionTabSnapshots(state, false)[0]
      const fileTabId = route === 'tabless' ? file.id : 'tab-1'

      expect(snapshot?.tabs).toMatchObject([
        { id: fileTabId, type: 'file', relativePath: 'app.ts', isActive: false }
      ])
      expect(snapshot?.tabs).toHaveLength(1)
      expect(snapshot?.activeTabId).toBeNull()
      expect(snapshot?.activeTabType).toBeNull()
      if (route === 'tabless' || route === 'legacy') {
        expect(snapshot?.tabGroups).toBeUndefined()
      } else {
        expect(snapshot?.tabGroups).toEqual([
          {
            id: 'group-1',
            activeTabId: null,
            tabOrder: [fileTabId],
            recentTabIds: [fileTabId]
          }
        ])
      }
    }
  )
})
