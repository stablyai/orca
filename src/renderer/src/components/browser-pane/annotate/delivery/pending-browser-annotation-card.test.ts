// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { PendingBrowserAnnotationCard } from './pending-browser-annotation-card'
import type { BrowserGrabPayload } from '../../../../../../shared/browser/element-grab/browser-grab-types'

type OutsideEvent = { defaultPrevented: boolean; preventDefault: () => void }
const popover = vi.hoisted(() => ({
  onOpenChange: (_open: boolean): void => {},
  onInteractOutside: (_event: OutsideEvent): void => {}
}))
// The popover's outside-press plumbing doesn't run in this DOM; the card's own dismissal decision is what's tested.
vi.mock('@/components/ui/popover', () => ({
  Popover: (props: { children: ReactNode; onOpenChange: (open: boolean) => void }) => {
    popover.onOpenChange = props.onOpenChange
    return props.children
  },
  PopoverAnchor: (props: { children: ReactNode }) => props.children,
  PopoverContent: (props: {
    children: ReactNode
    onInteractOutside: (e: OutsideEvent) => void
  }) => {
    popover.onInteractOutside = props.onInteractOutside
    return props.children
  }
}))
vi.mock('./use-browser-annotation-images', () => ({
  useBrowserAnnotationImages: () => ({
    images: [],
    imagePaths: [],
    saving: false,
    handlePaste: () => {},
    removeImage: () => {}
  })
}))

afterEach(cleanup)

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the card reads only the target's name fields.
const payload = {
  target: { tagName: 'button', selector: 'button', textSnippet: 'Buy', accessibility: {} }
} as unknown as BrowserGrabPayload

/** What an outside press (opening the toolbar's right-click or ⋯ menu) does to the card. */
function pressOutside(): void {
  const event = {
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true
    }
  }
  act(() => {
    popover.onInteractOutside(event)
    if (!event.defaultPrevented) {
      popover.onOpenChange(false)
    }
  })
}

it('a comment with text survives an outside press such as opening a toolbar menu; an empty one dismisses', () => {
  const onCancel = vi.fn()
  const view = render(
    createElement(PendingBrowserAnnotationCard, {
      payload,
      worktreeId: 'wt',
      resolveAnchor: () => ({ x: 0, y: 0, side: 'bottom' }),
      portalContainer: null,
      onAdd: () => {},
      onCancel
    })
  )
  const comment = view.getByRole('textbox')
  fireEvent.change(comment, { target: { value: 'Make this green' } })
  pressOutside()
  pressOutside()
  expect(onCancel).not.toHaveBeenCalled()
  expect(view.getByRole('textbox')).toHaveProperty('value', 'Make this green')

  fireEvent.change(comment, { target: { value: '  ' } })
  pressOutside()
  expect(onCancel).toHaveBeenCalledOnce()
})
