// @vitest-environment happy-dom
import { DndContext } from '@dnd-kit/core'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import { TopActivityOverflowMenu, type ActivityBarItem } from './activity-bar-buttons'
import { RightSidebarTopActivityBar } from './right-sidebar-top-activity-bar'
import { getTopActivityBarLayout } from './activity-bar-overflow'

const items: ActivityBarItem[] = [
  { id: 'explorer', title: 'Explorer', icon: () => null, shortcut: '' },
  { id: 'plugin:test:panel', pluginKey: 'test', title: 'Plugin', icon: () => null, shortcut: '' }
]

afterEach(() => {
  cleanup()
  useAppStore.setState({ activityBarOrder: [], activityBarHidden: [] })
})

it('hides and restores an overflowed panel through its context menu', () => {
  render(
    <TopActivityOverflowMenu
      items={[items[1]]}
      arrangementItems={items}
      activeTab="explorer"
      onSelect={vi.fn()}
      activityBarPosition="top"
      onChangeActivityBarPosition={vi.fn()}
    />
  )
  fireEvent.pointerDown(screen.getByRole('button', { name: 'More sidebar tabs' }), {
    button: 0,
    pointerType: 'mouse',
    ctrlKey: false
  })
  fireEvent.contextMenu(screen.getByRole('menuitem', { name: 'Plugin' }), {
    clientX: 40,
    clientY: 20
  })
  fireEvent.click(screen.getByRole('menuitem', { name: 'Hide' }))
  expect(useAppStore.getState().activityBarHidden).toEqual(['plugin:test:panel'])
  fireEvent.contextMenu(screen.getByRole('menuitem', { name: 'Plugin' }), {
    clientX: 40,
    clientY: 20
  })
  fireEvent.click(screen.getByRole('menuitem', { name: 'Show Plugin' }))
  expect(useAppStore.getState().activityBarHidden).toEqual([])
})

it('moves past hidden tabs and resets the arrangement', () => {
  const tabs: ActivityBarItem[] = [
    items[0],
    items[1],
    { id: 'checks', title: 'Checks', icon: () => null, shortcut: '' }
  ]
  useAppStore.setState({
    activityBarOrder: ['explorer', 'plugin:test:panel', 'checks'],
    activityBarHidden: ['plugin:test:panel']
  })
  render(
    <TopActivityOverflowMenu
      items={[tabs[2]]}
      arrangementItems={tabs}
      activeTab="explorer"
      onSelect={vi.fn()}
      activityBarPosition="top"
      onChangeActivityBarPosition={vi.fn()}
    />
  )
  fireEvent.pointerDown(screen.getByRole('button', { name: 'More sidebar tabs' }), {
    button: 0,
    pointerType: 'mouse',
    ctrlKey: false
  })
  fireEvent.contextMenu(screen.getByRole('menuitem', { name: 'Checks' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Move left' }))
  expect(useAppStore.getState().activityBarOrder).toEqual([
    'checks',
    'plugin:test:panel',
    'explorer'
  ])
  fireEvent.contextMenu(screen.getByRole('menuitem', { name: 'Checks' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Reset tab order' }))
  expect(useAppStore.getState().activityBarOrder).toEqual([])
  expect(useAppStore.getState().activityBarHidden).toEqual([])
})

it('names the checks status on its overflowed row', () => {
  const checks: ActivityBarItem = { id: 'checks', title: 'Checks', icon: () => null, shortcut: '' }
  render(
    <TopActivityOverflowMenu
      items={[checks]}
      arrangementItems={[items[0], checks]}
      activeTab="explorer"
      onSelect={vi.fn()}
      checksStatus="failure"
      activityBarPosition="top"
      onChangeActivityBarPosition={vi.fn()}
    />
  )
  fireEvent.pointerDown(screen.getByRole('button', { name: 'More sidebar tabs — Error' }), {
    button: 0,
    pointerType: 'mouse',
    ctrlKey: false
  })
  expect(screen.getByRole('menuitem', { name: 'Checks — Error' })).toBeTruthy()
})

it('opens the neighbouring panel when hiding the active panel', () => {
  useAppStore.setState({
    rightSidebarEffectiveTab: 'plugin:test:panel',
    rightSidebarTab: 'plugin:test:panel'
  })
  render(
    <TopActivityOverflowMenu
      items={[items[1]]}
      arrangementItems={items}
      activeTab="plugin:test:panel"
      onSelect={vi.fn()}
      activityBarPosition="top"
      onChangeActivityBarPosition={vi.fn()}
    />
  )
  fireEvent.pointerDown(screen.getByRole('button', { name: 'More sidebar tabs' }), {
    button: 0,
    pointerType: 'mouse',
    ctrlKey: false
  })
  fireEvent.contextMenu(screen.getByRole('menuitem', { name: 'Plugin' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Hide' }))
  expect(useAppStore.getState().rightSidebarTab).toBe('explorer')
})

it.each(['ContextMenu', 'F10'])('opens the overflow context menu with %s', (key) => {
  render(
    <TopActivityOverflowMenu
      items={[items[1]]}
      arrangementItems={items}
      activeTab="explorer"
      onSelect={vi.fn()}
      activityBarPosition="top"
      onChangeActivityBarPosition={vi.fn()}
    />
  )
  fireEvent.pointerDown(screen.getByRole('button', { name: 'More sidebar tabs' }), {
    button: 0,
    pointerType: 'mouse',
    ctrlKey: false
  })
  const item = screen.getByRole('menuitem', { name: 'Plugin' })
  item.focus()
  fireEvent.keyDown(item, { key, shiftKey: key === 'F10' })
  expect(screen.getByRole('menuitem', { name: 'Hide' })).toBeTruthy()
})

it('focuses the neighbouring overflow item after hiding from the menu', async () => {
  const first: ActivityBarItem = {
    id: 'plugin:test:first',
    pluginKey: 'test',
    title: 'First',
    icon: () => null,
    shortcut: ''
  }
  const second: ActivityBarItem = {
    id: 'plugin:test:second',
    pluginKey: 'test',
    title: 'Second',
    icon: () => null,
    shortcut: ''
  }
  const all = [first, second]
  function Overflow() {
    const hidden = useAppStore((s) => s.activityBarHidden)
    return (
      <TopActivityOverflowMenu
        items={all.filter((item) => !hidden.includes(item.id))}
        arrangementItems={all}
        activeTab="explorer"
        onSelect={vi.fn()}
        activityBarPosition="top"
        onChangeActivityBarPosition={vi.fn()}
      />
    )
  }
  render(<Overflow />)
  fireEvent.pointerDown(screen.getByRole('button', { name: 'More sidebar tabs' }), {
    button: 0,
    pointerType: 'mouse',
    ctrlKey: false
  })
  const firstItem = screen.getByRole('menuitem', { name: 'First' })
  firstItem.focus()
  fireEvent.keyDown(firstItem, { key: 'F10', shiftKey: true })
  fireEvent.click(screen.getByRole('menuitem', { name: 'Hide' }))
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Second' }))
  )
})

it('focuses the neighbouring tab when hiding the last overflowed plugin removes More', async () => {
  const tabs: ActivityBarItem[] = [
    { id: 'explorer', title: 'Explorer', icon: () => null, shortcut: '' },
    { id: 'vault', title: 'Vault', icon: () => null, shortcut: '' },
    { id: 'workspaces', title: 'Workspaces', icon: () => null, shortcut: '' },
    { id: 'source-control', title: 'Source Control', icon: () => null, shortcut: '' },
    { id: 'checks', title: 'Checks', icon: () => null, shortcut: '' },
    { id: 'plugin:test:panel', pluginKey: 'test', title: 'Plugin', icon: () => null, shortcut: '' }
  ]
  function Bar() {
    const hidden = useAppStore((state) => state.activityBarHidden)
    const visible = tabs.filter((tab) => !hidden.includes(tab.id))
    return (
      <DndContext>
        <RightSidebarTopActivityBar
          hasDesktopWindowChrome={false}
          topActivityStripRef={vi.fn()}
          topActivityLayout={getTopActivityBarLayout(visible, 200, 'explorer')}
          effectiveTab="explorer"
          onSelectTab={vi.fn()}
          checksStatus={null}
          closeButton={null}
          activityBarPosition="top"
          onChangeActivityBarPosition={vi.fn()}
          arrangementItems={tabs}
        />
      </DndContext>
    )
  }
  render(<Bar />)
  fireEvent.pointerDown(screen.getByRole('button', { name: 'More sidebar tabs' }), {
    button: 0,
    pointerType: 'mouse',
    ctrlKey: false
  })
  const plugin = screen.getByRole('menuitem', { name: 'Plugin' })
  plugin.focus()
  fireEvent.keyDown(plugin, { key: 'F10', shiftKey: true })
  fireEvent.click(screen.getByRole('menuitem', { name: 'Hide' }))
  await waitFor(() => {
    expect(screen.queryByRole('button', { name: 'More sidebar tabs' })).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Checks' }))
  })
})
