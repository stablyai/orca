// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { CommandDialog, CommandInput, CommandItem, CommandList } from './command'

let root: Root | null = null

afterEach(() => {
  if (root) {
    act(() => root!.unmount())
  }
  root = null
  document.body.replaceChildren()
})

describe('CommandDialog modal slots', () => {
  it('marks overlay and content as dialog slots for the body-lock recovery observer', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => {
      root!.render(
        <CommandDialog open onOpenChange={() => {}}>
          <CommandInput placeholder="Search" />
          <CommandList>
            <CommandItem value="alpha">alpha</CommandItem>
          </CommandList>
        </CommandDialog>
      )
    })

    // Why: the Radix body pointer-events recovery observer only treats
    // [data-slot="dialog-overlay"/"dialog-content"][data-state="open"] as an
    // active modal — raw primitives would let it clear the lock mid-dialog.
    expect(document.querySelector('[data-slot="dialog-overlay"][data-state="open"]')).not.toBeNull()
    expect(document.querySelector('[data-slot="dialog-content"][data-state="open"]')).not.toBeNull()
  })
})
