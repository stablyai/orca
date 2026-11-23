import { describe, expect, it } from 'vitest'
import { selectedNativeSessionId } from './selected-native-session-id'
import type { WorkspaceSessionState } from '../workspace-session/workspace-session-state-types'

const WORKSPACE = 'folder:working-projects'

describe('selected native chat ownership', () => {
  it('withholds identity when two groups claim the selected group id', () => {
    const state = {
      unifiedTabs: {
        [WORKSPACE]: [
          {
            id: 'tab-a',
            entityId: 'codex_A',
            groupId: 'selected',
            worktreeId: WORKSPACE,
            contentType: 'agent-session',
            label: 'Chat A',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      tabGroups: {
        [WORKSPACE]: [
          { id: 'selected', worktreeId: WORKSPACE, activeTabId: 'tab-a', tabOrder: ['tab-a'] },
          { id: 'selected', worktreeId: WORKSPACE, activeTabId: 'tab-b', tabOrder: ['tab-b'] }
        ]
      },
      activeGroupIdByWorktree: { [WORKSPACE]: 'selected' }
    } satisfies Pick<WorkspaceSessionState, 'unifiedTabs' | 'tabGroups' | 'activeGroupIdByWorktree'>

    expect(selectedNativeSessionId(state, WORKSPACE)).toBeUndefined()
  })
})
