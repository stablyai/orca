// @vitest-environment happy-dom

// Why: react-dom act() requires this flag outside react-test-renderer setups.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { act } from 'react'
import type { ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'

// Why: capture the props AddRepoDialogChrome passes to DialogContent so the
// Radix dismissal handlers can be invoked directly without a real portal.
const contentProps = vi.hoisted(() => ({ capture: vi.fn() }))

vi.mock('@/components/ui/dialog', () => {
  const Dialog = ({ children }: { children: ReactNode }) => <>{children}</>
  const DialogContent = (props: { children?: ReactNode } & Record<string, unknown>) => {
    contentProps.capture(props)
    return <div data-dialog-content>{props.children}</div>
  }
  return { Dialog, DialogContent }
})

import { AddRepoDialogChrome } from './AddRepoDialogChrome'

type ChromeProps = Parameters<typeof AddRepoDialogChrome>[0]

function renderChrome(overrides: Partial<ChromeProps>): { root: Root; container: HTMLElement } {
  const props: ChromeProps = {
    children: <div>step content</div>,
    isAdding: false,
    isCloning: false,
    isOpen: true,
    onBack: vi.fn(),
    onOpenChange: vi.fn(),
    step: 'clone',
    ...overrides
  }
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(<AddRepoDialogChrome {...props} />)
  })
  return { root, container }
}

function lastContentProps(): Record<string, unknown> {
  const calls = contentProps.capture.mock.calls
  return calls.at(-1)![0] as Record<string, unknown>
}

function dismissalHandlers(): [
  string,
  ((event: { preventDefault: () => void }) => void) | undefined
][] {
  const props = lastContentProps()
  return [
    [
      'onPointerDownOutside',
      props.onPointerDownOutside as ((event: { preventDefault: () => void }) => void) | undefined
    ],
    [
      'onInteractOutside',
      props.onInteractOutside as ((event: { preventDefault: () => void }) => void) | undefined
    ],
    [
      'onEscapeKeyDown',
      props.onEscapeKeyDown as ((event: { preventDefault: () => void }) => void) | undefined
    ]
  ]
}

describe('AddRepoDialogChrome dismissal guard', () => {
  it('prevents dismissal events while a clone is in flight', () => {
    const { root, container } = renderChrome({ isCloning: true })

    for (const [name, handler] of dismissalHandlers()) {
      expect(handler, `${name} must be wired`).toBeTypeOf('function')
      const preventDefault = vi.fn()
      handler!({ preventDefault })
      expect(preventDefault, `${name} must preventDefault during clone`).toHaveBeenCalledTimes(1)
    }
    unmount(root, container)
  })

  it('lets dismissal events through when no clone is running', () => {
    const { root, container } = renderChrome({ isCloning: false })

    for (const [name, handler] of dismissalHandlers()) {
      expect(handler, `${name} must be wired`).toBeTypeOf('function')
      const preventDefault = vi.fn()
      handler!({ preventDefault })
      expect(preventDefault, `${name} must not preventDefault without clone`).not.toHaveBeenCalled()
    }
    unmount(root, container)
  })
})

function unmount(root: Root, container: HTMLElement): void {
  act(() => root.unmount())
  container.remove()
}
