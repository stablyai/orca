// @vitest-environment happy-dom
import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { GlobalSettings } from '../../../../shared/settings/global-settings-types'
import { getDefaultSettings } from '../../../../shared/orca-profiles/constants'
import { AppRail } from './AppRail'
import { APP_RAIL_SLOT_PX } from './app-rail-overflow'

// Invariant: a Customize toggle that swaps the rail's "…" and More (one page more folds the rail, one fewer unfolds it)
// leaves the checklist open in the new form with focus on the toggled row, so another page can change without
// reopening anything. Rendered in StrictMode: the replacement's submenu must survive StrictMode's extra effect pass.

const initial = useAppStore.getState()
// Workspaces, two pages, "…" and the account button is one slot too many: a second page folds the rail.
const CAPACITY = 4

function start(shown: Partial<GlobalSettings>): void {
  useAppStore.setState({
    settings: {
      ...(initial.settings ?? getDefaultSettings('/fixture-home')),
      experimentalAppRail: true,
      showTasksButton: true,
      showAutomationsButton: false,
      showArtifactsButton: false,
      showSkillsButton: false,
      showMobileButton: false,
      ...shown
    },
    // The write lands a tick later, as it does through the settings bridge.
    updateSettings: async (updates) => {
      await Promise.resolve()
      useAppStore.setState((state) =>
        state.settings ? { settings: { ...state.settings, ...updates } } : {}
      )
    }
  })
  render(
    <StrictMode>
      <TooltipProvider>
        <AppRail listVisible />
      </TooltipProvider>
    </StrictMode>
  )
}

function railItem(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-app-rail-item="${id}"]`)
}

function row(name: string): HTMLElement {
  return screen.getByRole('menuitemcheckbox', { name })
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function toggle(name: string, via: 'click' | 'space'): Promise<void> {
  const target = row(name)
  if (via === 'click') {
    fireEvent.pointerDown(target, { pointerType: 'mouse', button: 0 })
    fireEvent.click(target)
  } else {
    // Arrow keys from the row that has focus, as a keyboard user would; focus must follow them.
    const rows = screen.getAllByRole('menuitemcheckbox')
    for (let step = 0; step < rows.length && document.activeElement !== target; step++) {
      const active = document.activeElement
      const from = active instanceof HTMLElement ? rows.indexOf(active) : -1
      fireEvent.keyDown(document.activeElement!, {
        key: rows.indexOf(target) > from ? 'ArrowDown' : 'ArrowUp'
      })
      await settle()
    }
    expect(document.activeElement).toBe(target)
    fireEvent.keyDown(target, { key: ' ' })
  }
  await settle()
}

function expectChecklistOn(name: string, checked: boolean): void {
  const focused = row(name)
  expect(document.activeElement).toBe(focused)
  expect(focused.getAttribute('aria-checked')).toBe(String(checked))
}

beforeEach(() => {
  useAppStore.setState(initial, true)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement
  ) {
    const height = this.getAttribute('role') === 'toolbar' ? CAPACITY * APP_RAIL_SLOT_PX : 0
    return DOMRect.fromRect({ x: 0, y: 0, width: 40, height })
  })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  useAppStore.setState(initial, true)
})

it.each(['click', 'space'] as const)(
  'keeps the checklist open on the toggled row as "…" folds into More and back (%s)',
  async (via) => {
    start({})
    expect(railItem('customize')).not.toBeNull()
    fireEvent.pointerDown(railItem('customize')!, {
      button: 0,
      ctrlKey: false
    })
    await settle()

    // Tall → fold: a second page doesn't fit, so "…" becomes More.
    await toggle('Automations', via)
    expect(railItem('customize')).toBeNull()
    expect(railItem('more')).not.toBeNull()
    expectChecklistOn('Automations', true)

    // A second, different row from the reopened checklist: fold → tall as Tasks leaves.
    await toggle('Tasks', via)
    expect(railItem('more')).toBeNull()
    expect(railItem('customize')).not.toBeNull()
    expectChecklistOn('Tasks', false)

    // And once more without reopening: tall → fold.
    await toggle('Artifacts', via)
    expect(railItem('more')).not.toBeNull()
    expectChecklistOn('Artifacts', true)
    expect(useAppStore.getState().settings).toMatchObject({
      showTasksButton: false,
      showAutomationsButton: true,
      showArtifactsButton: true
    })
  }
)

it('lets the checklist close for good once it is dismissed', async () => {
  start({})
  fireEvent.pointerDown(railItem('customize')!, { button: 0, ctrlKey: false })
  await settle()
  await toggle('Automations', 'click')
  expect(railItem('more')).not.toBeNull()
  fireEvent.keyDown(row('Automations'), { key: 'Escape' })
  await settle()
  expect(screen.queryByRole('menuitemcheckbox')).toBeNull()

  // A later swap from outside the checklist (Settings' switch) must not bring it back.
  await act(async () => {
    await useAppStore.getState().updateSettings({ showAutomationsButton: false })
  })
  await settle()
  expect(railItem('customize')).not.toBeNull()
  expect(screen.queryByRole('menuitemcheckbox')).toBeNull()
})

function hover(element: HTMLElement): void {
  fireEvent.pointerMove(element, { pointerType: 'mouse' })
  fireEvent.pointerLeave(element, { pointerType: 'mouse' })
}

function checklistOpen(): boolean {
  return screen.queryAllByRole('menuitemcheckbox').length > 0
}

it('keeps a checklist reopened under the pointer open while the pointer crosses More to reach it', async () => {
  start({})
  fireEvent.pointerDown(railItem('customize')!, { button: 0, ctrlKey: false })
  await settle()
  await toggle('Automations', 'click')
  expect(railItem('more')).not.toBeNull()
  // More's own row for the folded page sits where the clicked row was.
  const sibling = screen.getByRole('menuitem', { name: 'Automations' })

  hover(sibling)
  await settle()
  expect(checklistOpen()).toBe(true)

  // Once the pointer has reached the checklist, More's rows hover as usual again.
  fireEvent.pointerMove(row('Tasks'), { pointerType: 'mouse' })
  hover(sibling)
  await settle()
  expect(checklistOpen()).toBe(false)
})

it('leaves More hovering as usual when a keyboard toggle reopens the checklist', async () => {
  start({})
  fireEvent.pointerDown(railItem('customize')!, { button: 0, ctrlKey: false })
  await settle()
  await toggle('Automations', 'space')
  expectChecklistOn('Automations', true)

  hover(screen.getByRole('menuitem', { name: 'Automations' }))
  await settle()
  expect(checklistOpen()).toBe(false)
})
