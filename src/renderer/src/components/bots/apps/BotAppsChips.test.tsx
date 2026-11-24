// @vitest-environment happy-dom

import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { BotAppsChips, type BotAppsView } from './BotAppsChips'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

it('keeps the same visible categories when a wide label is picked from More', async () => {
  const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')!.get!
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (
    this: HTMLElement
  ) {
    return this.getAttribute('role') === 'radiogroup' ? 530 : width.call(this)
  })

  const naturalWidths = new Map([
    ['All', 50],
    ['Coding', 60],
    ['Docs and projects', 100],
    ['Mail and meetings', 160],
    ['Composio', 92],
    ['Custom', 75],
    ['More', 68]
  ])
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

  function Filters(): React.JSX.Element {
    const [view, setView] = useState<BotAppsView>('all')
    return <BotAppsChips view={view} onView={setView} categories={['coding', 'docs', 'mail']} />
  }

  render(<Filters />)
  const visibleLabels = (): (string | null)[] =>
    screen.getAllByRole('radio').map((el) => el.textContent)
  expect(visibleLabels()).toEqual(['All', 'Coding', 'More', 'Composio', 'Custom'])

  const more = screen.getByRole('radio', { name: 'More' })
  fireEvent.keyDown(more, { key: 'ArrowDown' })
  fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Mail and meetings' }))

  expect(screen.getByRole('radio', { name: 'Mail and meetings', checked: true })).toBe(more)
  expect(visibleLabels()).toEqual(['All', 'Coding', 'Mail and meetings', 'Composio', 'Custom'])
})
