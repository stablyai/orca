// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Command, CommandInput, CommandItem, CommandList } from './command'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('CommandInput caret navigation', () => {
  let root: Root | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    if (root) {
      act(() => {
        root!.unmount()
      })
      root = null
    }
    container?.remove()
    container = null
  })

  it('stops propagation for Home and End keys to preserve native text caret navigation', () => {
    const onKeyDown = vi.fn()
    const onCommandRootKeyDown = vi.fn()

    act(() => {
      root!.render(
        <div onKeyDown={onCommandRootKeyDown}>
          <Command>
            <CommandInput onKeyDown={onKeyDown} placeholder="Search..." />
            <CommandList>
              <CommandItem value="item-1">Item 1</CommandItem>
              <CommandItem value="item-2">Item 2</CommandItem>
            </CommandList>
          </Command>
        </div>
      )
    })

    const input = container!.querySelector('input[data-slot="command-input"]') as HTMLInputElement
    expect(input).not.toBeNull()

    // Test Home key
    const homeEvent = new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true })
    const stopPropagationSpyHome = vi.spyOn(homeEvent, 'stopPropagation')
    act(() => {
      input.dispatchEvent(homeEvent)
    })

    expect(stopPropagationSpyHome).toHaveBeenCalled()
    expect(onKeyDown).toHaveBeenCalledTimes(1)
    expect(onCommandRootKeyDown).not.toHaveBeenCalled()
    expect(homeEvent.defaultPrevented).toBe(false)

    // Test End key
    const endEvent = new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true })
    const stopPropagationSpyEnd = vi.spyOn(endEvent, 'stopPropagation')
    act(() => {
      input.dispatchEvent(endEvent)
    })

    expect(stopPropagationSpyEnd).toHaveBeenCalled()
    expect(onKeyDown).toHaveBeenCalledTimes(2)
    expect(onCommandRootKeyDown).not.toHaveBeenCalled()
    expect(endEvent.defaultPrevented).toBe(false)
  })

  it('allows ArrowDown and other navigation keys to bubble to cmdk', () => {
    const onCommandRootKeyDown = vi.fn()

    act(() => {
      root!.render(
        <div onKeyDown={onCommandRootKeyDown}>
          <Command>
            <CommandInput placeholder="Search..." />
            <CommandList>
              <CommandItem value="item-1">Item 1</CommandItem>
              <CommandItem value="item-2">Item 2</CommandItem>
            </CommandList>
          </Command>
        </div>
      )
    })

    const input = container!.querySelector('input[data-slot="command-input"]') as HTMLInputElement
    expect(input).not.toBeNull()

    const arrowDownEvent = new KeyboardEvent('keydown', {
      key: 'ArrowDown',
      bubbles: true,
      cancelable: true
    })
    const stopPropagationSpy = vi.spyOn(arrowDownEvent, 'stopPropagation')
    act(() => {
      input.dispatchEvent(arrowDownEvent)
    })

    expect(stopPropagationSpy).not.toHaveBeenCalled()
    expect(onCommandRootKeyDown).toHaveBeenCalled()
  })
})
