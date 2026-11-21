import { describe, expect, it } from 'vitest'
import { selectedNativeSessionId } from './selected-native-session-id'
import type { WorkspaceSessionState } from '../workspace-session/workspace-session-state-types'
import type { Tab } from './tab-groups/tab-types'

const WORKSPACE = 'folder:working-projects'
function tab(
  id: string,
  entityId: string,
  groupId = 'left',
  contentType: Tab['contentType'] = 'agent-session'
): Tab {
  return {
    id,
    entityId,
    groupId,
    worktreeId: WORKSPACE,
    contentType,
    label: id,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}
function focused() {
  return {
    unifiedTabs: {
      [WORKSPACE]: [
        tab('tab-a', 'codex_A'),
        tab('tab-b', 'claude_B'),
        tab('notes', '/notes.md', 'right', 'editor')
      ]
    },
    tabGroups: {
      [WORKSPACE]: [
        { id: 'left', worktreeId: WORKSPACE, activeTabId: 'tab-a', tabOrder: ['tab-a', 'tab-b'] },
        { id: 'right', worktreeId: WORKSPACE, activeTabId: 'notes', tabOrder: ['notes'] }
      ]
    },
    activeGroupIdByWorktree: { [WORKSPACE]: 'left' }
  } satisfies Pick<WorkspaceSessionState, 'unifiedTabs' | 'tabGroups' | 'activeGroupIdByWorktree'>
}

describe('selected native chat identity', () => {
  it('follows exact chat and split-group selection, clearing on an editor', () => {
    const state = focused()
    expect(selectedNativeSessionId(state, WORKSPACE)).toBe('codex_A')
    state.tabGroups[WORKSPACE][0]!.activeTabId = 'tab-b'
    expect(selectedNativeSessionId(state, WORKSPACE)).toBe('claude_B')
    state.activeGroupIdByWorktree[WORKSPACE] = 'right'
    expect(selectedNativeSessionId(state, WORKSPACE)).toBeNull()
  })

  it('never guesses from missing or ambiguous groups, tabs, membership or invalid native ids', () => {
    const missingGroup = focused()
    missingGroup.activeGroupIdByWorktree[WORKSPACE] = 'missing'
    const duplicateGroup = focused()
    duplicateGroup.tabGroups[WORKSPACE].push({ ...duplicateGroup.tabGroups[WORKSPACE][0]! })
    const missingTab = focused()
    missingTab.tabGroups[WORKSPACE][0]!.activeTabId = 'removed'
    const duplicateTab = focused()
    duplicateTab.unifiedTabs[WORKSPACE].push({ ...duplicateTab.unifiedTabs[WORKSPACE][0]! })
    const wrongGroup = focused()
    wrongGroup.unifiedTabs[WORKSPACE][0]!.groupId = 'right'
    const wrongWorkspace = focused()
    wrongWorkspace.unifiedTabs[WORKSPACE][0]!.worktreeId = 'folder:another'
    const wrongGroupOwner = focused()
    wrongGroupOwner.tabGroups[WORKSPACE][0]!.worktreeId = 'folder:elsewhere'
    const missingOrder = focused()
    missingOrder.tabGroups[WORKSPACE][0]!.tabOrder = ['tab-b']
    const invalidId = focused()
    invalidId.unifiedTabs[WORKSPACE][0]!.entityId = '/provider/transcript.jsonl'
    for (const state of [
      undefined,
      {},
      missingGroup,
      duplicateGroup,
      missingTab,
      duplicateTab,
      wrongGroup,
      wrongWorkspace,
      wrongGroupOwner,
      missingOrder,
      invalidId
    ]) {
      expect(selectedNativeSessionId(state, WORKSPACE)).toBeUndefined()
    }
  })
})
