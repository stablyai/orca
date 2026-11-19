// @vitest-environment happy-dom
import type { ReactElement } from 'react'
import { DndContext } from '@dnd-kit/core'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import type { ActivityBarItem } from './activity-bar-buttons'
import { RightSidebarTopActivityBar } from './right-sidebar-top-activity-bar'

const explorer: ActivityBarItem = {
  id: 'explorer',
  title: 'Explorer',
  icon: () => null,
  shortcut: ''
}
const checks: ActivityBarItem = { id: 'checks', title: 'Checks', icon: () => null, shortcut: '' }
const plugin: ActivityBarItem = {
  id: 'plugin:test/panel',
  pluginKey: 'test',
  title: 'Plugin',
  icon: () => null,
  shortcut: ''
}
const items = [explorer, checks, plugin]

type BarProps = {
  isBotPage: boolean
  visibleItems?: ActivityBarItem[]
  overflowItems?: ActivityBarItem[]
  hiddenActiveItem?: ActivityBarItem
  effectiveTab?: string
  arrangementItems?: ActivityBarItem[]
}

function bar({
  isBotPage,
  visibleItems = items,
  overflowItems = [],
  hiddenActiveItem,
  effectiveTab = 'explorer',
  arrangementItems = items
}: BarProps): ReactElement {
  return (
    <DndContext>
      <RightSidebarTopActivityBar
        hasDesktopWindowChrome={false}
        topActivityStripRef={vi.fn()}
        topActivityLayout={{ visibleItems, overflowItems, compactIds: new Set() }}
        effectiveTab={effectiveTab}
        onSelectTab={vi.fn()}
        checksStatus={null}
        closeButton={null}
        activityBarPosition="top"
        onChangeActivityBarPosition={vi.fn()}
        arrangementItems={arrangementItems}
        hiddenActiveItem={hiddenActiveItem}
        isBotPage={isBotPage}
      />
    </DndContext>
  )
}

function isDisabled(element: HTMLElement): boolean {
  return element.getAttribute('aria-disabled') === 'true'
}

function openMenuOn(name: string): void {
  const button = screen.getByRole('button', { name })
  button.focus()
  fireEvent.keyDown(button, { key: 'F10', shiftKey: true })
}

beforeEach(() => {
  useAppStore.setState({
    activityBarOrder: [],
    activityBarBotOrder: [],
    activityBarHidden: [],
    rightSidebarEffectiveTab: null
  })
})

afterEach(() => {
  cleanup()
  useAppStore.setState({
    activityBarOrder: [],
    activityBarBotOrder: [],
    activityBarHidden: [],
    rightSidebarEffectiveTab: null
  })
})

it('keeps bot-page and workspace move orders apart in both directions', () => {
  const { rerender } = render(bar({ isBotPage: true }))
  openMenuOn('Checks')
  fireEvent.click(screen.getByRole('menuitem', { name: 'Move left' }))
  const state = useAppStore.getState()
  expect(state.activityBarBotOrder).toEqual(['checks', 'explorer', 'plugin:test/panel'])
  expect(state.activityBarOrder).toEqual([])

  rerender(bar({ isBotPage: false }))
  openMenuOn('Plugin')
  fireEvent.click(screen.getByRole('menuitem', { name: 'Move left' }))
  const after = useAppStore.getState()
  expect(after.activityBarOrder).toEqual(['explorer', 'plugin:test/panel', 'checks'])
  expect(after.activityBarBotOrder).toEqual(['checks', 'explorer', 'plugin:test/panel'])
})

it('Reset clears the workspace and bot-page orders and hidden plugins together', () => {
  useAppStore.setState({
    activityBarOrder: ['explorer', 'plugin:test/panel', 'checks'],
    activityBarBotOrder: ['checks', 'explorer', 'plugin:test/panel'],
    activityBarHidden: ['plugin:test/panel']
  })
  render(bar({ isBotPage: false, visibleItems: [explorer, checks] }))
  openMenuOn('Explorer')
  const reset = screen.getByRole('menuitem', { name: 'Reset tab order' })
  expect(isDisabled(reset)).toBe(false)
  fireEvent.click(reset)
  const state = useAppStore.getState()
  expect(state.activityBarOrder).toEqual([])
  expect(state.activityBarBotOrder).toEqual([])
  expect(state.activityBarHidden).toEqual([])
})

it('disables Reset when nothing is customized', () => {
  render(bar({ isBotPage: false }))
  openMenuOn('Explorer')
  expect(isDisabled(screen.getByRole('menuitem', { name: 'Reset tab order' }))).toBe(true)
})

it('disables Move left on the first strip tab and Move right on the last', () => {
  render(bar({ isBotPage: false }))
  openMenuOn('Explorer')
  expect(isDisabled(screen.getByRole('menuitem', { name: 'Move left' }))).toBe(true)
  expect(isDisabled(screen.getByRole('menuitem', { name: 'Move right' }))).toBe(false)
})

it('moves only among strip tabs when a tab is in More', () => {
  // `checks` is under More, so Move right from `plugin` (the last strip tab) is disabled.
  render(
    bar({
      isBotPage: false,
      visibleItems: [explorer, plugin],
      overflowItems: [checks],
      arrangementItems: items
    })
  )
  openMenuOn('Plugin')
  expect(isDisabled(screen.getByRole('menuitem', { name: 'Move right' }))).toBe(true)
})

it('shows an active More trigger while a hidden active plugin tab sits under it', () => {
  render(
    bar({
      isBotPage: false,
      visibleItems: [explorer, checks],
      overflowItems: [],
      hiddenActiveItem: plugin,
      effectiveTab: plugin.id
    })
  )
  const trigger = document.querySelector<HTMLElement>('[data-activity-overflow-trigger]')
  expect(trigger).not.toBeNull()
  expect(trigger?.hasAttribute('data-holds-active-tab')).toBe(true)
})

it('does not mark More active when the open tab is in the strip', () => {
  render(bar({ isBotPage: false, overflowItems: [checks], effectiveTab: 'explorer' }))
  const trigger = document.querySelector<HTMLElement>('[data-activity-overflow-trigger]')
  expect(trigger).not.toBeNull()
  expect(trigger?.hasAttribute('data-holds-active-tab')).toBe(false)
})

it('focuses the More trigger when hiding a plugin whose neighbour is under More', async () => {
  useAppStore.setState({ rightSidebarEffectiveTab: plugin.id })
  render(
    bar({
      isBotPage: false,
      visibleItems: [explorer, plugin],
      overflowItems: [checks],
      effectiveTab: plugin.id,
      arrangementItems: [explorer, plugin, checks]
    })
  )
  openMenuOn('Plugin')
  fireEvent.click(screen.getByRole('menuitem', { name: 'Hide' }))
  await waitFor(() =>
    expect(document.activeElement).toBe(document.querySelector('[data-activity-overflow-trigger]'))
  )
})
