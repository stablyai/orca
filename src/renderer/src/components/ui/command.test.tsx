// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Command, CommandInput, CommandItem, CommandList } from './command'

// cmdk puts its Enter->select dispatch on the Command root and guards it with
// only `isComposing || keyCode === 229`. macOS redispatches the Enter that
// confirms a CJK composition as an unmarked Enter/13, which that guard lets
// through. These pin the veto our root handler adds — the guard itself lives in
// a dependency and cannot be fixed at the source.

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function render(onSelect: () => void): HTMLInputElement {
  act(() => {
    root.render(
      <Command shouldFilter={false}>
        <CommandInput placeholder="Search templates..." />
        <CommandList>
          <CommandItem value="가나다 template" onSelect={onSelect}>
            template
          </CommandItem>
        </CommandList>
      </Command>
    )
  })
  return container.querySelector('input')!
}

function key(input: HTMLInputElement, type: 'keydown' | 'keyup', init: KeyboardEventInit): void {
  const event = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init })
  Object.defineProperty(event, 'keyCode', { value: init.keyCode })
  Object.defineProperty(event, 'isComposing', { value: init.isComposing === true })
  act(() => input.dispatchEvent(event))
}

function composition(
  input: HTMLInputElement,
  type: 'compositionstart' | 'compositionend',
  data = ''
) {
  act(() => input.dispatchEvent(new CompositionEvent(type, { bubbles: true, data })))
}

// The carry expires on the NEXT FRAME, never synchronously — macOS delivers keyup
// before its unmarked redispatch. A human pressing a later deliberate Enter is many
// frames away, so advance one.
function advanceFrame(run: () => void): void {
  let frame: FrameRequestCallback | undefined
  const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
    frame = cb
    return 1
  })
  run()
  act(() => frame?.(0))
  raf.mockRestore()
}

describe('Command IME Enter ownership', () => {
  it('selects the highlighted item on an ordinary Enter', () => {
    const onSelect = vi.fn()
    const input = render(onSelect)

    key(input, 'keydown', { key: 'Enter', code: 'Enter', keyCode: 13 })

    expect(onSelect).toHaveBeenCalledOnce()
  })

  // Recorded macOS 2-Set Korean shape: the confirming Enter arrives twice, and the
  // second one is unmarked. Before the veto this created a file the user never asked
  // for while their search text was still mid-word.
  it('does not select on the unmarked Enter that macOS redispatches after compositionend', () => {
    const onSelect = vi.fn()
    const input = render(onSelect)

    composition(input, 'compositionstart')
    key(input, 'keydown', { key: 'Process', code: 'Enter', keyCode: 229, isComposing: true })
    composition(input, 'compositionend', '가')
    key(input, 'keydown', { key: 'Enter', code: 'Enter', keyCode: 13, isComposing: false })
    key(input, 'keyup', { key: 'Enter', code: 'Enter', keyCode: 13 })

    expect(onSelect).not.toHaveBeenCalled()
  })

  it('selects on the deliberate Enter that follows a confirmed composition', () => {
    const onSelect = vi.fn()
    const input = render(onSelect)

    composition(input, 'compositionstart')
    key(input, 'keydown', { key: 'Process', code: 'Enter', keyCode: 229, isComposing: true })
    composition(input, 'compositionend', '가')
    key(input, 'keydown', { key: 'Enter', code: 'Enter', keyCode: 13, isComposing: false })
    advanceFrame(() => key(input, 'keyup', { key: 'Enter', code: 'Enter', keyCode: 13 }))

    key(input, 'keydown', { key: 'Enter', code: 'Enter', keyCode: 13, isComposing: false })

    expect(onSelect).toHaveBeenCalledOnce()
  })

  // Windows/Linux redispatch the unmarked Enter BEFORE keyup, so the carry must not
  // depend on the macOS ordering.
  it('does not select when the redispatch precedes keyup', () => {
    const onSelect = vi.fn()
    const input = render(onSelect)

    composition(input, 'compositionstart')
    key(input, 'keydown', { key: 'Enter', code: 'Enter', keyCode: 229, isComposing: true })
    key(input, 'keydown', { key: 'Enter', code: 'Enter', keyCode: 13, isComposing: false })
    composition(input, 'compositionend', '가')
    key(input, 'keyup', { key: 'Enter', code: 'Enter', keyCode: 13 })

    expect(onSelect).not.toHaveBeenCalled()
  })

  it('still forwards a consumer onKeyDown for keys the IME does not own', () => {
    const onKeyDown = vi.fn()
    act(() => {
      root.render(
        <Command shouldFilter={false} onKeyDown={onKeyDown}>
          <CommandInput />
          <CommandList>
            <CommandItem value="a">a</CommandItem>
          </CommandList>
        </Command>
      )
    })
    const input = container.querySelector('input')!

    key(input, 'keydown', { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 })

    expect(onKeyDown).toHaveBeenCalledOnce()
  })
})
