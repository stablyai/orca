import { describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import type { Tab } from '../../../../shared/tab-types'
import { tabSessionLinkRequest } from './tab-session-link'

function chat(id: string, workspace = 'workspace'): Tab {
  return {
    id: `tab-${id}`,
    entityId: id,
    worktreeId: workspace,
    groupId: 'group',
    contentType: 'agent-session',
    agentSessionAgent: 'codex',
    executionHostId: 'local',
    label: id,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}
function state(active: Tab | null, clicked = chat('partner')) {
  return {
    ...useAppStore.getState(),
    activeWorktreeId: active?.worktreeId ?? 'workspace',
    unifiedTabsByWorktree: { [clicked.worktreeId]: [clicked] },
    getActiveTab: () => active
  }
}
describe('tabSessionLinkRequest', () => {
  it('pairs the selected chat with the right-clicked chat across workspaces', () => {
    const selected = { ...chat('source', 'folder-workspace'), customLabel: 'Implementation' }
    const clicked = { ...chat('partner'), customLabel: 'Architecture review' }
    expect(tabSessionLinkRequest(state(selected, clicked), clicked.worktreeId, clicked.id)).toEqual(
      {
        sessionId: 'source',
        sourceName: 'Implementation',
        partnerSessionId: 'partner',
        partnerName: 'Architecture review'
      }
    )
  })
  it('opens the picker for the selected chat instead of linking it to itself', () => {
    const selected = chat('source')
    expect(
      tabSessionLinkRequest(state(selected, selected), selected.worktreeId, selected.id)
    ).toEqual({
      sessionId: 'source',
      sourceName: 'source'
    })
  })
  it('uses the clicked chat when an editor is selected', () => {
    const selected = { ...chat('editor'), contentType: 'editor' as const }
    expect(tabSessionLinkRequest(state(selected), 'workspace', 'tab-partner')).toEqual({
      sessionId: 'partner',
      sourceName: 'partner'
    })
  })
  it('does not offer local links for remote chats or terminal tabs', () => {
    const remote = { ...chat('partner'), executionHostId: 'runtime:remote' as const }
    expect(tabSessionLinkRequest(state(null, remote), 'workspace', remote.id)).toBeNull()
    const terminal = { ...chat('terminal'), contentType: 'terminal' as const }
    expect(tabSessionLinkRequest(state(null, terminal), 'workspace', terminal.id)).toBeNull()
  })
})
