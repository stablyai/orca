// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SET_WORKTREE_TERMINAL_AUTO_SCROLL_EVENT,
  type SetWorktreeTerminalAutoScrollDetail
} from '@/constants/terminal'
import type { AppState } from '@/store/types'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../../shared/types'
import {
  areWorktreeTerminalsFollowingOutput,
  setWorktreeTerminalAutoScroll
} from './worktree-terminal-auto-scroll'

const mocks = vi.hoisted(() => ({
  getTerminalScrollIntentKindByKey: vi.fn(
    (_leafId: string): 'followOutput' | 'pinnedViewport' => 'followOutput'
  ),
  setTerminalScrollIntentKindByKey: vi.fn()
}))

vi.mock('@/lib/pane-manager/terminal-scroll-intent', () => ({
  getTerminalScrollIntentKindByKey: mocks.getTerminalScrollIntentKindByKey,
  setTerminalScrollIntentKindByKey: mocks.setTerminalScrollIntentKindByKey
}))

const LEAF_1 = '11111111-1111-4111-8111-111111111111'
const LEAF_2 = '22222222-2222-4222-8222-222222222222'
const LEAF_3 = '33333333-3333-4333-8333-333333333333'

function terminalTab(id: string, worktreeId: string): TerminalTab {
  return {
    id,
    worktreeId,
    ptyId: null,
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

function state(
  tabsByWorktree: AppState['tabsByWorktree'],
  terminalLayoutsByTabId: AppState['terminalLayoutsByTabId']
): Pick<AppState, 'tabsByWorktree' | 'terminalLayoutsByTabId'> {
  return { tabsByWorktree, terminalLayoutsByTabId }
}

function layout(rootLeafIds: readonly [string, string?]): TerminalLayoutSnapshot {
  const [first, second] = rootLeafIds
  return {
    root: second
      ? {
          type: 'split',
          direction: 'vertical',
          first: { type: 'leaf', leafId: first },
          second: { type: 'leaf', leafId: second }
        }
      : { type: 'leaf', leafId: first },
    activeLeafId: first,
    expandedLeafId: null
  }
}

describe('worktree terminal auto-scroll', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getTerminalScrollIntentKindByKey.mockReturnValue('followOutput')
  })

  it('enables every durable pane before dispatching', () => {
    const dispatchEvent = vi.spyOn(window, 'dispatchEvent')
    setWorktreeTerminalAutoScroll(
      state(
        {
          'wt-1': [terminalTab('tab-1', 'wt-1')],
          'wt-2': [terminalTab('tab-2', 'wt-2')]
        },
        {
          'tab-1': layout([LEAF_1, LEAF_2]),
          'tab-2': layout([LEAF_3])
        }
      ),
      ['wt-1', 'wt-2'],
      true
    )

    expect(mocks.setTerminalScrollIntentKindByKey.mock.calls).toEqual([
      [LEAF_1, 'followOutput'],
      [LEAF_2, 'followOutput'],
      [LEAF_3, 'followOutput']
    ])
    const event = dispatchEvent.mock.calls[0]?.[0]
    expect(event?.type).toBe(SET_WORKTREE_TERMINAL_AUTO_SCROLL_EVENT)
    expect((event as CustomEvent<SetWorktreeTerminalAutoScrollDetail>).detail).toEqual({
      worktreeIds: ['wt-1', 'wt-2'],
      enabled: true
    })
    expect(dispatchEvent.mock.invocationCallOrder[0]).toBeGreaterThan(
      mocks.setTerminalScrollIntentKindByKey.mock.invocationCallOrder.at(-1) ?? 0
    )
  })

  it('disables every durable pane before dispatching the pinned state', () => {
    const dispatchEvent = vi.spyOn(window, 'dispatchEvent')
    const targetState = state(
      { 'wt-1': [terminalTab('tab-1', 'wt-1')] },
      { 'tab-1': layout([LEAF_1, LEAF_2]) }
    )

    setWorktreeTerminalAutoScroll(targetState, ['wt-1'], false)

    expect(mocks.setTerminalScrollIntentKindByKey.mock.calls).toEqual([
      [LEAF_1, 'pinnedViewport'],
      [LEAF_2, 'pinnedViewport']
    ])
    const event = dispatchEvent.mock.calls[0]?.[0]
    expect(event).toBeInstanceOf(CustomEvent)
    expect((event as CustomEvent<SetWorktreeTerminalAutoScrollDetail>).detail).toEqual({
      worktreeIds: ['wt-1'],
      enabled: false
    })
  })

  it('reports enabled only when every targeted pane follows output', () => {
    const targetState = state(
      { 'wt-1': [terminalTab('tab-1', 'wt-1')] },
      { 'tab-1': layout([LEAF_1, LEAF_2]) }
    )
    expect(areWorktreeTerminalsFollowingOutput(targetState, ['wt-1'])).toBe(true)

    mocks.getTerminalScrollIntentKindByKey.mockImplementation((leafId: string) =>
      leafId === LEAF_2 ? 'pinnedViewport' : 'followOutput'
    )
    expect(areWorktreeTerminalsFollowingOutput(targetState, ['wt-1'])).toBe(false)
    expect(areWorktreeTerminalsFollowingOutput(state({}, {}), ['wt-1'])).toBe(false)
  })

  it('uses the active durable leaf for a rootless pre-replay layout', () => {
    setWorktreeTerminalAutoScroll(
      state(
        { 'wt-1': [terminalTab('tab-1', 'wt-1')] },
        {
          'tab-1': {
            root: null,
            activeLeafId: LEAF_3,
            expandedLeafId: null,
            ptyIdsByLeafId: { [LEAF_1]: 'pty-1', [LEAF_2]: 'pty-2' }
          }
        }
      ),
      ['wt-1'],
      true
    )

    expect(mocks.setTerminalScrollIntentKindByKey).toHaveBeenCalledOnce()
    expect(mocks.setTerminalScrollIntentKindByKey).toHaveBeenCalledWith(LEAF_3, 'followOutput')
  })

  it('falls back to a sole durable PTY binding when a rootless layout has no active leaf', () => {
    setWorktreeTerminalAutoScroll(
      state(
        { 'wt-1': [terminalTab('tab-1', 'wt-1')] },
        {
          'tab-1': {
            root: null,
            activeLeafId: null,
            expandedLeafId: null,
            ptyIdsByLeafId: { [LEAF_2]: 'pty-2' }
          }
        }
      ),
      ['wt-1'],
      true
    )

    expect(mocks.setTerminalScrollIntentKindByKey).toHaveBeenCalledWith(LEAF_2, 'followOutput')
  })
})
