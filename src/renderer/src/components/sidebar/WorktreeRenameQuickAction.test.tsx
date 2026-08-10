// @vitest-environment happy-dom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  WorktreeRenameQuickAction,
  worktreeHeaderActionsPaddingClass
} from './WorktreeRenameQuickAction'

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

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

function renderAction(props: Partial<Parameters<typeof WorktreeRenameQuickAction>[0]> = {}): {
  onRename: ReturnType<typeof vi.fn>
  onPointerDown: ReturnType<typeof vi.fn>
  button: HTMLButtonElement
} {
  const onRename = vi.fn()
  const onPointerDown = vi.fn()
  act(() => {
    root.render(
      <WorktreeRenameQuickAction
        hasPrecedingAction={false}
        onPointerDown={onPointerDown}
        onRename={onRename}
        {...props}
      />
    )
  })
  const button = container.querySelector<HTMLButtonElement>('[data-worktree-rename-quick-action]')
  expect(button).not.toBeNull()
  return { onRename, onPointerDown, button: button! }
}

describe('WorktreeRenameQuickAction', () => {
  it('invokes the rename handler on click', () => {
    const { onRename, button } = renderAction()

    act(() => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(onRename).toHaveBeenCalledTimes(1)
  })

  it('cancels the flex gap only when another action renders before it', () => {
    const { button: withoutSibling } = renderAction({ hasPrecedingAction: false })
    expect(withoutSibling.className).not.toContain('-ml-1')

    act(() => root.unmount())
    root = createRoot(container)

    const { button: withSibling } = renderAction({ hasPrecedingAction: true })
    // Why: a zero-width sibling still contributes the parent's gap-1, which would
    // shift the primary-star row by 4px if it were not cancelled while collapsed.
    expect(withSibling.className).toContain('-ml-1')
    expect(withSibling.className).toContain('group-hover/worktree-card:ml-0')
  })
})

describe('worktreeHeaderActionsPaddingClass', () => {
  it('reserves the trailing gutter when an always-visible action is present', () => {
    expect(worktreeHeaderActionsPaddingClass(true)).toBe('pr-1.5')
  })

  it('defers the trailing gutter to hover when rename is the only action', () => {
    const className = worktreeHeaderActionsPaddingClass(false)

    expect(className).toContain('pr-0')
    expect(className).toContain('group-hover/worktree-card:pr-1.5')
    expect(className).toContain('group-focus-within/worktree-card:pr-1.5')
  })
})
