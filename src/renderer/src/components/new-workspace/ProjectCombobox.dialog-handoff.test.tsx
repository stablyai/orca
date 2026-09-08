// @vitest-environment happy-dom

import React, { act, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import ProjectCombobox from './ProjectCombobox'

vi.mock('./use-recent-project-ids', () => ({ useRecentProjectIds: () => [] }))

function Composer({ populated }: { populated: boolean }): React.JSX.Element {
  const [adding, setAdding] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)
  return (
    <Dialog open>
      <DialogContent aria-describedby={undefined}>
        <DialogTitle>New workspace</DialogTitle>
        <ProjectCombobox
          options={
            populated
              ? [
                  {
                    kind: 'project',
                    id: 'project:existing',
                    projectId: 'project:existing',
                    displayName: 'Existing project',
                    badgeColor: 'var(--muted)',
                    detail: 'Project'
                  }
                ]
              : []
          }
          value={populated ? 'project:existing' : null}
          onValueChange={vi.fn()}
          onAddProject={() => setAdding(true)}
        />
        <input ref={nameRef} aria-label="Workspace name" />
        <Dialog open={adding} onOpenChange={setAdding}>
          <DialogContent
            aria-describedby={undefined}
            onCloseAutoFocus={(event) => {
              event.preventDefault()
              nameRef.current?.focus()
            }}
          >
            <DialogTitle>Add a project</DialogTitle>
            <input aria-label="Project path" />
            <button onClick={() => setAdding(false)}>Cancel</button>
          </DialogContent>
        </Dialog>
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
            : Reflect.get(target, property)
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
    option.textContent?.includes('Add a new project')
  )!
}

describe.each([false, true])(
  'project selector to nested dialog handoff (populated: %s)',
  (populated) => {
    it.each(['mouse', 'keyboard'] as const)(
      'removes the selector before the creation dialog is active via %s',
      async (input) => {
        await act(async () => root.render(<Composer populated={populated} />))
        await act(async () => projectField().click())
        expect(document.querySelector('[role="listbox"]')).not.toBeNull()

        await act(async () => {
          if (input === 'mouse') {
            addOption().dispatchEvent(
              new MouseEvent('mousedown', { bubbles: true, cancelable: true })
            )
            addOption().click()
          } else if (populated) {
            projectField().dispatchEvent(
              new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })
            )
          }
        })
        if (input === 'keyboard') {
          await act(async () => {
            projectField().dispatchEvent(
              new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
            )
          })
        }

        expect(document.querySelector('[role="listbox"]')).toBeNull()
        expect(document.querySelector('[data-slot="popover-content"]')).toBeNull()
        expect(projectField().getAttribute('aria-expanded')).toBe('false')
        expect(projectField().hasAttribute('aria-activedescendant')).toBe(false)
        const path = document.querySelector<HTMLInputElement>('[aria-label="Project path"]')!
        expect(document.activeElement).toBe(path)
        expect(path.closest('[aria-hidden="true"]')).toBeNull()
        expect(projectField().closest('[aria-hidden="true"]')).not.toBeNull()

        await act(async () => {
          Array.from(document.querySelectorAll('button'))
            .find((b) => b.textContent === 'Cancel')!
            .click()
        })
        await vi.waitFor(() =>
          expect(document.activeElement).toBe(
            document.querySelector('[aria-label="Workspace name"]')
          )
        )
        await act(async () => projectField().click())
        expect(projectField().getAttribute('aria-expanded')).toBe('true')
        expect(document.querySelector('[role="listbox"]')).not.toBeNull()
      }
    )
  }
)
