import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tab } from '../../../shared/tab-types'
import { structuredAgentSessionTabId } from '../../../shared/structured-agent-session-projection'

const mockResolveAgentLaunchGroupId =
  vi.fn<(worktreeId: string, callerGroupId: string | undefined) => string | undefined>()
const mockCreateUnifiedTab = vi.fn()
const mockFocusGroup = vi.fn()
const mockActivateTab = vi.fn()
const mockSetActiveTabType = vi.fn()

// Why an annotated const rather than a cast: type assertions are forbidden in this repo.
const emptyUnifiedTabs: Record<string, Tab[]> = {}

const store = {
  unifiedTabsByWorktree: emptyUnifiedTabs,
  resolveAgentLaunchGroupId: mockResolveAgentLaunchGroupId,
  createUnifiedTab: mockCreateUnifiedTab,
  focusGroup: mockFocusGroup,
  activateTab: mockActivateTab,
  setActiveTabType: mockSetActiveTabType
}

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => store
  }
}))

const WT = 'wt-1'
const SESSION_ID = 'session-1'

function agentSessionTab(groupId: string): Tab {
  return {
    id: structuredAgentSessionTabId(SESSION_ID),
    entityId: SESSION_ID,
    groupId,
    worktreeId: WT,
    contentType: 'agent-session',
    label: 'Claude',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

describe('openStructuredAgentSessionProvisionalTab', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    store.unifiedTabsByWorktree = {}
    mockResolveAgentLaunchGroupId.mockReturnValue('card-group-1')
    mockCreateUnifiedTab.mockImplementation(
      (worktreeId: string, _contentType: string, init: { targetGroupId?: string }) =>
        agentSessionTab(init.targetGroupId ?? `${worktreeId}-home`)
    )
  })

  it('does not resolve a card group when the session already owns a tab', async () => {
    const existing = agentSessionTab('existing-group')
    store.unifiedTabsByWorktree = { [WT]: [existing] }
    const { openStructuredAgentSessionProvisionalTab } =
      await import('./structured-agent-session-provisional-tab')

    const tab = openStructuredAgentSessionProvisionalTab({
      worktreeId: WT,
      sessionId: SESSION_ID,
      agent: 'claude'
    })

    expect(tab).toBe(existing)
    expect(mockResolveAgentLaunchGroupId).not.toHaveBeenCalled()
    expect(mockCreateUnifiedTab).not.toHaveBeenCalled()
  })

  it('resolves the card group when it creates the tab', async () => {
    const { openStructuredAgentSessionProvisionalTab } =
      await import('./structured-agent-session-provisional-tab')

    const tab = openStructuredAgentSessionProvisionalTab({
      worktreeId: WT,
      sessionId: SESSION_ID,
      agent: 'claude',
      targetGroupId: 'caller-group'
    })

    expect(mockResolveAgentLaunchGroupId).toHaveBeenCalledWith(WT, 'caller-group')
    expect(tab.groupId).toBe('card-group-1')
  })
})
