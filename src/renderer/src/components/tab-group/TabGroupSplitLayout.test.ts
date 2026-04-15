import { describe, expect, it, vi } from 'vitest'

const setTabGroupSplitRatioMock = vi.fn()
const useAppStoreMock = vi.fn(
  (selector: (state: { setTabGroupSplitRatio: () => void }) => unknown) =>
    selector({ setTabGroupSplitRatio: setTabGroupSplitRatioMock })
)
vi.mock('../../store', () => ({
  useAppStore: (selector: (state: { setTabGroupSplitRatio: () => void }) => unknown) =>
    useAppStoreMock(selector)
}))

vi.mock('./TabGroupPanel', () => ({
  default: (props: unknown) => ({ __mock: 'TabGroupPanel', props })
}))

import TabGroupSplitLayout from './TabGroupSplitLayout'

describe('TabGroupSplitLayout', () => {
  function getLeafPanelProps(isWorktreeActive: boolean) {
    const element = TabGroupSplitLayout({
      layout: { type: 'leaf', groupId: 'group-1' },
      worktreeId: 'wt-1',
      focusedGroupId: 'group-1',
      isWorktreeActive
    })

    const splitNodeElement = element.props.children
    const tabGroupPanelElement = splitNodeElement.type(splitNodeElement.props)
    return tabGroupPanelElement.props as {
      groupId: string
      worktreeId: string
      isFocused: boolean
      hasSplitGroups: boolean
    }
  }

  it('does not mark an offscreen worktree group as focused', () => {
    expect(getLeafPanelProps(false)).toEqual(
      expect.objectContaining({
        groupId: 'group-1',
        worktreeId: 'wt-1',
        isFocused: false,
        hasSplitGroups: false
      })
    )
  })

  it('keeps the visible worktree focused group active', () => {
    expect(getLeafPanelProps(true)).toEqual(
      expect.objectContaining({
        groupId: 'group-1',
        worktreeId: 'wt-1',
        isFocused: true,
        hasSplitGroups: false
      })
    )
  })
})
