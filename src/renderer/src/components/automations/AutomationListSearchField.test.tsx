// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AutomationListSearchField } from './AutomationListSearchField'

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
})

describe('AutomationListSearchField', () => {
  it('autofocuses the search input on mount', () => {
    act(() => {
      root.render(
        <AutomationListSearchField
          query=""
          isTooLarge={false}
          onQueryChange={() => undefined}
          onClear={() => undefined}
        />
      )
    })

    const input = container.querySelector('input')
    expect(input).not.toBeNull()
    expect(document.activeElement).toBe(input)
  })

  it('routes ArrowDown/ArrowUp into onArrowNavigate and keeps Escape clear working', () => {
    const onArrowNavigate = vi.fn()
    const onClear = vi.fn()
    act(() => {
      root.render(
        <AutomationListSearchField
          query="prod"
          isTooLarge={false}
          onQueryChange={() => undefined}
          onClear={onClear}
          onArrowNavigate={onArrowNavigate}
        />
      )
    })

    const input = container.querySelector('input')
    expect(input).not.toBeNull()

    const down = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })
    input?.dispatchEvent(down)
    expect(down.defaultPrevented).toBe(true)
    expect(onArrowNavigate).toHaveBeenCalledWith('ArrowDown')

    const up = new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true })
    input?.dispatchEvent(up)
    expect(up.defaultPrevented).toBe(true)
    expect(onArrowNavigate).toHaveBeenCalledWith('ArrowUp')

    const modified = new KeyboardEvent('keydown', {
      key: 'ArrowDown',
      metaKey: true,
      bubbles: true,
      cancelable: true
    })
    input?.dispatchEvent(modified)
    expect(modified.defaultPrevented).toBe(false)
    expect(onArrowNavigate).toHaveBeenCalledTimes(2)

    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    input?.dispatchEvent(escape)
    expect(escape.defaultPrevented).toBe(true)
    expect(onClear).toHaveBeenCalledTimes(1)
  })

  it('routes Enter into onEnter and ignores modified or composing Enter', () => {
    const onEnter = vi.fn()
    act(() => {
      root.render(
        <AutomationListSearchField
          query="nightly"
          isTooLarge={false}
          onQueryChange={() => undefined}
          onClear={() => undefined}
          onEnter={onEnter}
        />
      )
    })

    const input = container.querySelector('input')
    expect(input).not.toBeNull()

    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    input?.dispatchEvent(enter)
    expect(enter.defaultPrevented).toBe(true)
    expect(onEnter).toHaveBeenCalledTimes(1)

    const shiftEnter = new KeyboardEvent('keydown', {
      key: 'Enter',
      shiftKey: true,
      bubbles: true,
      cancelable: true
    })
    input?.dispatchEvent(shiftEnter)
    expect(shiftEnter.defaultPrevented).toBe(false)
    expect(onEnter).toHaveBeenCalledTimes(1)
  })
})
