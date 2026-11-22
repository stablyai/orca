import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/bot-catalog', () => ({
  readBots: () => [{ id: 'bot-1', folderWorkspaceId: 'fw-1', chatSessionId: 'home-session' }],
  readBotsEnabled: () => true,
  useBots: () => []
}))

import { closeMobileSessionTabInStore } from './web-session-tabs-sync/closing/mobile-session-tab-close'

function store(entityId: string) {
  return {
    unifiedTabsByWorktree: {
      'folder:fw-1': [
        { id: 'tab-1', entityId, worktreeId: 'folder:fw-1', contentType: 'agent-session' as const }
      ]
    },
    openFiles: [],
    closeFile: vi.fn(),
    closeUnifiedTab: vi.fn(() => ({ closedTabId: 'tab-1', wasLastTab: false, worktreeId: 'w' }))
  }
}

describe('closeMobileSessionTabInStore', () => {
  it("refuses to close a bot's Home tab", () => {
    const home = store('home-session')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the close reads only these fields.
    expect(closeMobileSessionTabInStore(home as never, 'folder:fw-1', 'tab-1')).toBe(false)
    expect(home.closeUnifiedTab).not.toHaveBeenCalled()
  })

  it('closes any other chat tab', () => {
    const other = store('other-session')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the close reads only these fields.
    expect(closeMobileSessionTabInStore(other as never, 'folder:fw-1', 'tab-1')).toBe(true)
    expect(other.closeUnifiedTab).toHaveBeenCalledWith('tab-1')
  })
})
