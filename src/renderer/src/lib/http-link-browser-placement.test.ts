import { describe, expect, it } from 'vitest'
import { resolveHttpLinkBrowserPlacement } from './http-link-browser-placement'

const WT = 'wt-1'
const terminal = { id: 'term', contentType: 'terminal' } as const
const browser = { id: 'browser', contentType: 'browser' } as const
const split = {
  type: 'split',
  direction: 'horizontal',
  first: { type: 'leaf', groupId: 'left' },
  second: { type: 'leaf', groupId: 'right' }
} as const

function state(overrides: {
  rightActiveTabId: string
  activeGroupId: string
  tabs?: { id: string; contentType: 'terminal' | 'browser' | 'editor' }[]
}): Parameters<typeof resolveHttpLinkBrowserPlacement>[0] {
  return {
    layoutByWorktree: { [WT]: split },
    activeGroupIdByWorktree: { [WT]: overrides.activeGroupId },
    groupsByWorktree: {
      [WT]: [
        { id: 'left', activeTabId: 'term' },
        { id: 'right', activeTabId: overrides.rightActiveTabId }
      ]
    },
    unifiedTabsByWorktree: { [WT]: overrides.tabs ?? [terminal, browser] }
  }
}

describe('resolveHttpLinkBrowserPlacement', () => {
  it('adds the link to a browser already on screen, whichever pane the link came from', () => {
    expect(
      resolveHttpLinkBrowserPlacement(
        state({ rightActiveTabId: 'browser', activeGroupId: 'left' }),
        WT
      )
    ).toEqual({ targetGroupId: 'right' })
    expect(
      resolveHttpLinkBrowserPlacement(
        state({ rightActiveTabId: 'browser', activeGroupId: 'right' }),
        WT
      )
    ).toEqual({ targetGroupId: 'right' })
  })

  it('ignores a browser hidden behind another tab and splits beside the source instead', () => {
    const editor = { id: 'editor', contentType: 'editor' } as const
    expect(
      resolveHttpLinkBrowserPlacement(
        state({
          rightActiveTabId: 'editor',
          activeGroupId: 'left',
          tabs: [terminal, browser, editor]
        }),
        WT
      )
    ).toEqual({
      split: { sourceGroupId: 'left', splitDirection: 'right', activate: false }
    })
  })

  it('fills an empty source pane rather than splitting beside it', () => {
    expect(
      resolveHttpLinkBrowserPlacement(
        state({ rightActiveTabId: '', activeGroupId: 'right', tabs: [terminal] }),
        WT
      )
    ).toEqual({ targetGroupId: 'right' })
  })
})
