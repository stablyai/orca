// @vitest-environment happy-dom

import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { BotAppsChips, type BotAppsView } from './BotAppsChips'
import { botAppCategoryName, type BotAppCategory } from './bot-app-catalog'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const naturalWidths = new Map([
  ['All', 50],
  ['Coding', 60],
  ['Docs and projects', 100],
  ['Mail and meetings', 160],
  ['Sales and support', 150],
  ['Composio', 92],
  ['Custom', 75],
  ['More', 68]
])

/** Chips at fixed natural widths in a row `rowWidth()` wide; returns a way to fire the row's resize. */
function layChips(rowWidth: () => number): () => void {
  const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')!.get!
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (
    this: HTMLElement
  ) {
    return this.getAttribute('role') === 'radiogroup' ? rowWidth() : width.call(this)
  })
  const computedStyle = window.getComputedStyle.bind(window)
  vi.spyOn(window, 'getComputedStyle').mockImplementation((node, pseudo) => {
    const naturalWidth = node.tagName === 'SPAN' && naturalWidths.get(node.textContent ?? '')
    if (!naturalWidth) {
      return computedStyle(node, pseudo)
    }
    const style = document.createElement('span').style
    style.width = `${naturalWidth + (node.querySelector('svg') ? 18 : 0)}px`
    return style
  })
  const rowObservers: (() => void)[] = []
  class RowResizeObserver implements ResizeObserver {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(target: Element): void {
      if (target.getAttribute('role') === 'radiogroup') {
        rowObservers.push(() => this.callback([], this))
      }
    }
    unobserve(): void {}
    disconnect(): void {}
  }
  vi.stubGlobal('ResizeObserver', RowResizeObserver)
  return () => act(() => rowObservers.forEach((resize) => resize()))
}

function Filters({ categories }: { categories: BotAppCategory[] }): React.JSX.Element {
  const [view, setView] = useState<BotAppsView>('all')
  return (
    <BotAppsChips
      view={view}
      onView={setView}
      categories={categories}
      categoryName={botAppCategoryName}
    />
  )
}

const visibleLabels = (): (string | null)[] =>
  screen.getAllByRole('radio').map((el) => el.textContent)

it('keeps the same visible categories when a wide label is picked from More', async () => {
  layChips(() => 530)
  render(<Filters categories={['coding', 'docs', 'mail']} />)
  expect(visibleLabels()).toEqual(['All', 'Coding', 'More', 'Composio', 'Custom'])

  const more = screen.getByRole('radio', { name: 'More' })
  fireEvent.keyDown(more, { key: 'ArrowDown' })
  fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Mail and meetings' }))

  expect(screen.getByRole('radio', { name: 'Mail and meetings', checked: true })).toBe(more)
  expect(visibleLabels()).toEqual(['All', 'Coding', 'Mail and meetings', 'Composio', 'Custom'])
})

it('hands focus to a focused More option’s chip when widening unfolds only that category', async () => {
  let width = 530
  const resize = layChips(() => width)
  render(<Filters categories={['coding', 'docs', 'mail', 'sales']} />)
  expect(visibleLabels()).toEqual(['All', 'Coding', 'More', 'Composio', 'Custom'])

  fireEvent.keyDown(screen.getByRole('radio', { name: 'More' }), { key: 'ArrowDown' })
  const docsOption = await screen.findByRole('menuitemradio', { name: 'Docs and projects' })
  act(() => docsOption.focus())
  expect(document.activeElement).toBe(docsOption)

  width = 600
  resize()

  // Docs unfolds while Mail and Sales stay in More; focus follows Docs without picking it.
  expect(visibleLabels()).toEqual([
    'All',
    'Coding',
    'Docs and projects',
    'More',
    'Composio',
    'Custom'
  ])
  const docsChip = screen.getByRole('radio', { name: 'Docs and projects' })
  expect(document.activeElement).toBe(docsChip)
  expect(docsChip.getAttribute('aria-checked')).toBe('false')
  expect(screen.getByRole('radio', { name: 'All' }).getAttribute('aria-checked')).toBe('true')
  expect(screen.queryByRole('menu')).toBeNull()

  fireEvent.keyDown(docsChip, { key: 'ArrowRight' })
  expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'More' }))
})

it('leaves focus on a More option that stays folded when widening', async () => {
  let width = 530
  const resize = layChips(() => width)
  render(<Filters categories={['coding', 'docs', 'mail', 'sales']} />)

  fireEvent.keyDown(screen.getByRole('radio', { name: 'More' }), { key: 'ArrowDown' })
  const mailOption = await screen.findByRole('menuitemradio', { name: 'Mail and meetings' })
  act(() => mailOption.focus())

  width = 600
  resize()

  expect(visibleLabels()).toEqual([
    'All',
    'Coding',
    'Docs and projects',
    'More',
    'Composio',
    'Custom'
  ])
  expect(document.activeElement).toBe(mailOption)
  expect(screen.getByRole('menu')).toBeTruthy()
})
