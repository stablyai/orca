import { describe, expect, it } from 'vitest'
import type { AppState } from '../store/types'
import { buildMobileSessionTabSnapshots } from './sync-runtime-graph'
import { makeState } from './sync-runtime-graph-test-harness'

describe('buildMobileSessionTabSnapshots markdown tabs', () => {
  it('publishes a renamed markdown tab through the workspace snapshot', () => {
    const fileId = '/repo/annotation.md'
    const state = makeState({
      activeGroupIdByWorktree: { 'wt-1': 'group-1' },
      groupsByWorktree: {
        'wt-1': [
          {
            id: 'group-1',
            activeTabId: 'annotation-tab',
            tabOrder: ['annotation-tab'],
            recentTabIds: ['annotation-tab']
          }
        ]
      } as unknown as AppState['groupsByWorktree'],
      unifiedTabsByWorktree: {
        'wt-1': [
          {
            id: 'annotation-tab',
            groupId: 'group-1',
            worktreeId: 'wt-1',
            contentType: 'editor',
            entityId: fileId,
            label: 'annotation.md',
            customLabel: 'Renamed exact warning',
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      openFiles: [
        {
          id: fileId,
          filePath: fileId,
          relativePath: 'annotation.md',
          worktreeId: 'wt-1',
          language: 'markdown',
          mode: 'edit',
          isDirty: false
        }
      ]
    })

    expect(buildMobileSessionTabSnapshots(state)[0]?.tabs).toMatchObject([
      { type: 'markdown', id: 'annotation-tab', title: 'Renamed exact warning' }
    ])
  })
})
