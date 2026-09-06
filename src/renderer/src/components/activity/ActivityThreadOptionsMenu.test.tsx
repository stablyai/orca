// @vitest-environment happy-dom

import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TooltipProvider } from '@/components/ui/tooltip'
import { ActivityThreadOptionsMenu } from './ActivityPrototypePage'
import type { ActivityGroupBy } from './activity-thread-types'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

function Harness({
  groupBy,
  onGroupByChange,
  compactMode = false,
  showChildAgents = false,
  onShowChildAgentsChange,
  hasUnreadThreads = true
}: {
  groupBy?: ActivityGroupBy
  onGroupByChange?: (groupBy: ActivityGroupBy) => void
  compactMode?: boolean
  showChildAgents?: boolean
  onShowChildAgentsChange?: (showChildAgents: boolean) => void
  hasUnreadThreads?: boolean
}): ReactElement {
  return (
    <TooltipProvider>
      <ActivityThreadOptionsMenu
        groupBy={groupBy}
        onGroupByChange={onGroupByChange}
        compactMode={compactMode}
        showChildAgents={showChildAgents}
        onShowChildAgentsChange={onShowChildAgentsChange}
        hasUnreadThreads={hasUnreadThreads}
        onCompactModeChange={vi.fn()}
        onMarkAllThreadsRead={vi.fn()}
      />
    </TooltipProvider>
  )
}

describe('ActivityThreadOptionsMenu', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    document.body.replaceChildren()
  })

  it('opens without recursively updating composed Radix trigger refs', async () => {
    await act(async () => {
      root.render(<Harness />)
    })

    const trigger = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Thread list options"]'
    )

    expect(trigger).not.toBeNull()
    expect(trigger?.parentElement?.tagName).toBe('SPAN')

    await act(async () => {
      trigger?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }))
    })

    expect(document.body.textContent).toContain('Compact mode')
  })

  it('renders group by options when provided', async () => {
    const onGroupByChange = vi.fn()
    await act(async () => {
      root.render(<Harness groupBy="status" onGroupByChange={onGroupByChange} />)
    })

    const trigger = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Thread list options"]'
    )

    await act(async () => {
      trigger?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }))
    })

    expect(document.body.textContent).toContain('Group by')
    expect(document.body.textContent).toContain('Status')

    const subTrigger = document.querySelector<HTMLElement>(
      '[data-slot="dropdown-menu-sub-trigger"]'
    )
    expect(subTrigger).not.toBeNull()

    await act(async () => {
      subTrigger?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowRight' }))
    })

    expect(document.body.textContent).toContain('Project')
    expect(document.body.textContent).toContain('Worktree')
    expect(document.body.textContent).toContain('Agent')
  })

  it('explains compact mode on hover', async () => {
    await act(async () => {
      root.render(<Harness />)
    })

    const trigger = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Thread list options"]'
    )
    await act(async () => {
      trigger?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }))
    })

    const compactMode = document.querySelector<HTMLElement>('[role="menuitemcheckbox"]')
    await act(async () => {
      compactMode?.dispatchEvent(new Event('pointermove', { bubbles: true }))
    })

    expect(document.body.textContent).toContain(
      'Shows shorter thread rows with one-line titles and two-line status messages.'
    )
  })

  it('puts search and unread actions in the menu when header overflow handlers are provided', async () => {
    const onSearch = vi.fn()
    const onToggleUnread = vi.fn()
    await act(async () => {
      root.render(
        <TooltipProvider>
          <ActivityThreadOptionsMenu
            compactMode={false}
            hasUnreadThreads={false}
            onCompactModeChange={vi.fn()}
            onMarkAllThreadsRead={vi.fn()}
            onSearch={onSearch}
            unreadOnly={false}
            onToggleUnread={onToggleUnread}
          />
        </TooltipProvider>
      )
    })

    const trigger = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Thread list options"]'
    )
    await act(async () => {
      trigger?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }))
    })

    expect(document.body.textContent).toContain('Search')
    expect(document.body.textContent).toContain('Show unread only')
  })

  it('explains show unread threads only on hover and shows unread dot when hasUnreadThreads is true', async () => {
    const onToggleUnread = vi.fn()
    await act(async () => {
      root.render(
        <TooltipProvider>
          <ActivityThreadOptionsMenu
            compactMode={false}
            hasUnreadThreads={true}
            onCompactModeChange={vi.fn()}
            onMarkAllThreadsRead={vi.fn()}
            unreadOnly={false}
            onToggleUnread={onToggleUnread}
          />
        </TooltipProvider>
      )
    })

    const trigger = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Thread list options"]'
    )
    await act(async () => {
      trigger?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }))
    })

    const unreadItem = document.querySelector<HTMLElement>('[role="menuitemcheckbox"]')
    await act(async () => {
      unreadItem?.dispatchEvent(new Event('pointermove', { bubbles: true }))
    })

    expect(document.body.textContent).toContain(
      'Filters the activity list to show only threads with unread updates.'
    )
    expect(document.querySelector('[data-unread-dot]')).not.toBeNull()
  })

  it('renders show child agents checkbox when onShowChildAgentsChange is provided', async () => {
    const onShowChildAgentsChange = vi.fn()
    await act(async () => {
      root.render(
        <Harness showChildAgents={false} onShowChildAgentsChange={onShowChildAgentsChange} />
      )
    })

    const trigger = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Thread list options"]'
    )

    await act(async () => {
      trigger?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }))
    })

    expect(document.body.textContent).toContain('Show child agents')
  })
})
