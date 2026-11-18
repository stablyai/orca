// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { TooltipProvider } from '@/components/ui/tooltip'
import { TabBarCreateRow } from './TabBarCreateRow'

const runTerminal = vi.fn()

function renderRow(): void {
  render(
    <TooltipProvider>
      <DropdownMenu open>
        <DropdownMenuTrigger>+</DropdownMenuTrigger>
        <DropdownMenuContent>
          <TabBarCreateRow
            customizable
            layoutSetting="newTabMenuLayout"
            items={[
              { id: 'terminal', label: 'New Terminal', icon: null, run: runTerminal },
              { id: 'browser', label: 'New Browser', icon: null, run: vi.fn() }
            ]}
          />
        </DropdownMenuContent>
      </DropdownMenu>
    </TooltipProvider>
  )
}

const icon = (id: string): HTMLElement =>
  document.querySelector<HTMLElement>(`[data-create-row-item="${id}"]`)!
const tooltip = (): HTMLElement | null => screen.queryByRole('tooltip')
const advance = (ms: number): void => {
  act(() => {
    vi.advanceTimersByTime(ms)
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('api', { ui: { setShortcutRecorderFocused: vi.fn() } })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('waits for a steady hover, then shows neighbours at once', () => {
  renderRow()
  fireEvent.pointerMove(icon('terminal'))
  advance(300)
  expect(tooltip()).toBeNull()

  fireEvent.pointerLeave(icon('terminal'))
  fireEvent.pointerMove(icon('browser'))
  advance(500)
  expect(tooltip()).toBeNull()
  advance(100)
  expect(tooltip()).toHaveTextContent('New Browser')

  fireEvent.pointerLeave(icon('browser'))
  fireEvent.pointerMove(icon('terminal'))
  expect(tooltip()).toHaveTextContent('New Terminal')
})

it('hides the label on press and keeps it hidden until the pointer leaves', () => {
  renderRow()
  fireEvent.pointerMove(icon('terminal'))
  advance(600)
  expect(tooltip()).toHaveTextContent('New Terminal')

  fireEvent.pointerDown(icon('terminal'))
  fireEvent.pointerMove(icon('terminal'))
  advance(1000)
  expect(tooltip()).toBeNull()
})

it('shows no label for a touch or a press dragged onto another icon', () => {
  renderRow()
  fireEvent.pointerDown(icon('terminal'), { pointerType: 'touch' })
  fireEvent.pointerMove(icon('terminal'), { pointerType: 'touch', buttons: 1 })
  advance(1000)
  expect(tooltip()).toBeNull()

  fireEvent.pointerLeave(icon('terminal'))
  fireEvent.pointerMove(icon('browser'))
  advance(600)
  expect(tooltip()).toHaveTextContent('New Browser')
  fireEvent.pointerDown(icon('browser'))
  fireEvent.pointerLeave(icon('browser'))
  fireEvent.pointerMove(icon('terminal'), { buttons: 1 })
  advance(1000)
  expect(tooltip()).toBeNull()
})

it('hands a keyboard label to the pointer without a cold wait', () => {
  renderRow()
  const row = screen.getByRole('menuitem', { name: /New tab actions/ })
  act(() => row.focus())
  fireEvent.keyDown(row, { key: 'ArrowRight' })
  expect(tooltip()).toHaveTextContent('New Browser')

  fireEvent.pointerEnter(row)
  advance(100)
  fireEvent.pointerMove(icon('browser'))
  expect(tooltip()).toHaveTextContent('New Browser')
})

it('hands a keyboard label to a pointer already inside the row', () => {
  renderRow()
  const row = screen.getByRole('menuitem', { name: /New tab actions/ })
  fireEvent.pointerEnter(row)
  act(() => row.focus())
  fireEvent.keyDown(row, { key: 'ArrowRight' })
  advance(1000)
  expect(tooltip()).toHaveTextContent('New Browser')

  fireEvent.pointerMove(icon('terminal'))
  expect(tooltip()).toHaveTextContent('New Terminal')
})

it('gives a press dragged in during keyboard navigation no head start', () => {
  renderRow()
  const row = screen.getByRole('menuitem', { name: /New tab actions/ })
  act(() => row.focus())
  fireEvent.keyDown(row, { key: 'ArrowRight' })
  expect(tooltip()).toHaveTextContent('New Browser')

  fireEvent.pointerEnter(row, { buttons: 1 })
  fireEvent.pointerMove(icon('terminal'), { buttons: 1 })
  fireEvent.pointerLeave(icon('terminal'))
  fireEvent.pointerMove(icon('browser'))
  expect(tooltip()).toBeNull()
})
