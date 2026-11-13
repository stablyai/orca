// @vitest-environment happy-dom

import React, { act, Suspense, useEffect, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import ProjectCombobox from './ProjectCombobox'
import { TooltipProvider } from '@/components/ui/tooltip'

vi.mock('./use-recent-project-ids', () => ({ useRecentProjectIds: () => [] }))

// Mirrors a lazily loaded creation dialog that focuses its primary action from a mount effect.
let resolveLateDialog: () => void = () => {}
const LateAddDialogBody = React.lazy(
  () =>
    new Promise<{ default: () => React.JSX.Element }>((resolve) => {
      resolveLateDialog = () =>
        resolve({
          default: function Body(): React.JSX.Element {
            const browseRef = useRef<HTMLButtonElement>(null)
            useEffect(() => browseRef.current?.focus(), [])
            return <button ref={browseRef}>Browse</button>
          }
        })
    })
)

function LateDialogComposer(): React.JSX.Element {
  const [adding, setAdding] = useState(false)
  return (
    <Dialog open>
      <DialogContent aria-describedby={undefined}>
        <DialogTitle>New workspace</DialogTitle>
        <ProjectCombobox
          options={[]}
          value={null}
          onValueChange={vi.fn()}
          onAddProject={() => setAdding(true)}
        />
        {adding ? (
          <Suspense fallback={null}>
            <Dialog open onOpenChange={setAdding}>
              <DialogContent aria-describedby={undefined}>
                <DialogTitle>Add a project</DialogTitle>
                <LateAddDialogBody />
              </DialogContent>
            </Dialog>
          </Suspense>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  // Radix Presence retains closing content when the production exit animation runs.
  const getStyle = window.getComputedStyle.bind(window)
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element, ...args) => {
    const style = getStyle(element, ...args)
    if (element.getAttribute('data-slot') === 'popover-content') {
      return new Proxy(style, {
        get: (target, property) =>
          property === 'animationName'
            ? element.getAttribute('data-state') === 'closed'
              ? 'exit'
              : 'enter'
            : // oxlint-disable-next-line anti-slop/no-reflect-get -- Proxy `get` trap: raw string|symbol pass-through; the receiver stays the target on purpose.
              Reflect.get(target, property)
      })
    }
    return style
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

function projectField(): HTMLInputElement {
  return document.querySelector<HTMLInputElement>('[role="combobox"][aria-label="Project"]')!
}

function addOption(): HTMLElement {
  return Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find((option) =>
    option.textContent?.includes('Add project')
  )!
}

it('keeps the selector closed when a late creation dialog focuses before its trap mounts', async () => {
  await act(async () =>
    root.render(
      <TooltipProvider>
        <LateDialogComposer />
      </TooltipProvider>
    )
  )
  // Dialog autofocus lands on the field, so the composer trap records it as last focused.
  expect(document.activeElement).toBe(projectField())
  expect(document.querySelector('[role="listbox"]')).not.toBeNull()

  await act(async () => {
    addOption().dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    addOption().click()
  })
  expect(document.querySelector('[role="listbox"]')).toBeNull()
  // Let the closed selector release its focus scope before the lazy dialog arrives.
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
  await act(async () => resolveLateDialog())

  expect(document.querySelector('[role="listbox"]')).toBeNull()
  expect(projectField().getAttribute('aria-expanded')).toBe('false')
})
