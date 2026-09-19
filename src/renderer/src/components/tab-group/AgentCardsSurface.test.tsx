// @vitest-environment happy-dom

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { TabGroup } from '../../../../shared/tab-types'

const storeBox: { state: Record<string, unknown> } = { state: {} }

vi.mock('../../store', () => {
  const useAppStore = Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) => selector(storeBox.state),
    { getState: () => storeBox.state }
  )
  return { useAppStore }
})

vi.mock('./AgentCard', () => ({
  AgentCard: (props: {
    cardGroupId: string
    tabId: string
    isMaximized: boolean
    frameTone?: string
  }) => (
    <div
      data-tab-group-body-id={props.cardGroupId}
      data-tab-id={props.tabId}
      data-maximized={String(props.isMaximized)}
      data-frame-tone={props.frameTone ?? ''}
    />
  )
}))

import { AgentCardsSurface } from './AgentCardsSurface'

const WORKTREE_ID = 'wt-1'

function makeGroup(id: string, activeTabId: string): TabGroup {
  return { id, worktreeId: WORKTREE_ID, activeTabId, tabOrder: [activeTabId] }
}

function setState(
  overrides: {
    cardGroupIds?: readonly string[]
    groups?: TabGroup[]
    maximizedGroupId?: string
  } = {}
) {
  const cardGroupIds = overrides.cardGroupIds ?? ['g1', 'g2', 'g3']
  storeBox.state = {
    settings: { ...getDefaultSettings('/tmp'), experimentalTiledAgents: true },
    agentCardGroupIdsByWorktree: { [WORKTREE_ID]: cardGroupIds },
    groupsByWorktree: {
      [WORKTREE_ID]:
        overrides.groups ?? cardGroupIds.map((id, index) => makeGroup(id, `t${index + 1}`))
    },
    maximizedGroupIdByWorktree: overrides.maximizedGroupId
      ? { [WORKTREE_ID]: overrides.maximizedGroupId }
      : {},
    unifiedTabsByWorktree: { [WORKTREE_ID]: [] },
    tabsByWorktree: { [WORKTREE_ID]: [] },
    agentStatusByPaneKey: {},
    agentStatusEpoch: 0
  }
}

describe('AgentCardsSurface', () => {
  afterEach(() => {
    cleanup()
  })

  it('renders one cell per card group id, in store order', () => {
    setState()
    const { container } = render(<AgentCardsSurface worktreeId={WORKTREE_ID} groupId="home" />)
    const cells = container.querySelectorAll('[data-orca-agent-card]')
    expect(Array.from(cells).map((cell) => cell.getAttribute('data-orca-agent-card'))).toEqual([
      'g1',
      'g2',
      'g3'
    ])
    expect(container.querySelector('[data-orca-agent-cards="wt-1"]')).not.toBeNull()
    expect(container.querySelectorAll('[data-tab-group-body-id]')).toHaveLength(3)
  })

  it('keeps every sibling mounted in a zero-size hidden wrapper while one card is enlarged', () => {
    setState({ maximizedGroupId: 'g2' })
    const { container } = render(<AgentCardsSurface worktreeId={WORKTREE_ID} groupId="home" />)
    expect(container.querySelectorAll('[data-tab-group-body-id]')).toHaveLength(3)

    const scrollContainer = container.querySelector('[data-orca-agent-cards]')
    expect(scrollContainer?.className).toContain('overflow-hidden')
    expect(scrollContainer?.className).not.toContain('overflow-y-auto')

    const maximizedCell = container.querySelector('[data-orca-agent-card="g2"]')
    expect(maximizedCell?.className).toContain('h-full')
    expect(maximizedCell?.className).toContain('w-full')

    for (const groupId of ['g1', 'g3']) {
      const hiddenCell = container.querySelector(`[data-orca-agent-card="${groupId}"]`)
      expect(hiddenCell?.className).toContain('h-0')
      expect(hiddenCell?.className).toContain('w-0')
      expect(hiddenCell?.getAttribute('aria-hidden')).toBe('true')
      // Why: zero size and overflow-hidden still leave the card's controls in the tab order.
      expect(hiddenCell?.hasAttribute('inert')).toBe(true)
    }
  })

  it('falls back to the ordinary grid when the maximized group id is not one of the cards', () => {
    setState({ maximizedGroupId: 'stale-group' })
    const { container } = render(<AgentCardsSurface worktreeId={WORKTREE_ID} groupId="home" />)
    const scrollContainer = container.querySelector('[data-orca-agent-cards]')
    expect(scrollContainer?.className).toContain('overflow-y-auto')
  })

  it('renders every cell inside one scrolling container using Walour track sizes', () => {
    const cardGroupIds = Array.from({ length: 9 }, (_unused, index) => `g${index + 1}`)
    setState({ cardGroupIds })
    const { container } = render(<AgentCardsSurface worktreeId={WORKTREE_ID} groupId="home" />)
    const scrollContainer = container.querySelector('[data-orca-agent-cards]')
    expect(scrollContainer?.className).toContain('overflow-y-auto')
    expect(container.querySelectorAll('[data-orca-agent-card]')).toHaveLength(9)
    const track = container.querySelector('.grid')
    // Why min(): the track floor must collapse in a split pane narrower than a card, or the
    // card's right edge and header controls end up behind the pane's hidden overflow.
    expect(track?.className).toContain('grid-cols-[repeat(auto-fit,minmax(min(420px,100%),1fr))]')
    expect(track?.className).toContain('auto-rows-[minmax(300px,1fr)]')
    expect(track?.className).toContain('min-h-full')
  })
})
