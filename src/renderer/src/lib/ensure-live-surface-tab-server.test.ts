import { beforeEach, describe, expect, it, vi } from 'vitest'

const { store, frameDrawnServer, noteCreatedHere, openThroughOwner } = vi.hoisted(() => ({
  store: {
    layoutByWorktree: {},
    createUnifiedTabInSplit: vi.fn(() => ({ id: 'split-tab' })),
    createUnifiedTab: vi.fn(),
    activateTab: vi.fn(),
    setActiveTabType: vi.fn(),
    getTab: vi.fn(() => ({ groupId: 'group-a' })),
    focusGroup: vi.fn()
  },
  frameDrawnServer: vi.fn<() => string | null>(),
  noteCreatedHere: vi.fn(),
  openThroughOwner: vi.fn(() => null)
}))

vi.mock('../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => store } }))
vi.mock('./simulator-tab-layout-owner', () => ({
  frameDrawnServerOfSimulatorTab: frameDrawnServer,
  noteSimulatorTabCreatedHere: noteCreatedHere,
  openingSimulatorTabId: () => undefined,
  openSimulatorTabThroughLayoutOwner: openThroughOwner
}))

import { createLiveSurfaceTabRightOf } from './ensure-simulator-tab'

describe('createLiveSurfaceTabRightOf in a layout-owner build', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('opens beside the source group and records the tab in a paired server workspace', () => {
    frameDrawnServer.mockReturnValue('env-1')

    const tabId = createLiveSurfaceTabRightOf('wt-1', 'group-a', 'desktop-app', 'Desktop App')

    expect(openThroughOwner).toHaveBeenCalledWith(
      store,
      expect.objectContaining({ kind: 'desktop-app', groupId: 'group-a', rightSplit: false })
    )
    expect(store.createUnifiedTabInSplit).not.toHaveBeenCalled()
    expect(store.createUnifiedTab).toHaveBeenCalledWith(
      'wt-1',
      'desktop-app',
      expect.objectContaining({ id: tabId, targetGroupId: 'group-a' })
    )
    expect(noteCreatedHere).toHaveBeenCalledWith('env-1', 'wt-1', tabId)
  })

  it('still splits right in a workspace this desktop owns', () => {
    frameDrawnServer.mockReturnValue(null)

    expect(createLiveSurfaceTabRightOf('wt-1', 'group-a', 'desktop-app', 'Desktop App')).toBe(
      'split-tab'
    )
    expect(openThroughOwner).toHaveBeenCalledWith(
      store,
      expect.objectContaining({ rightSplit: true })
    )
    expect(noteCreatedHere).not.toHaveBeenCalled()
  })
})
