// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RightPanelCommentComposer } from './right-panel-comment-composer'

vi.mock('@/components/ShortcutKeyCombo', () => ({
  ShortcutKeyCombo: () => <span />
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  TooltipTrigger: ({ children }: { children?: React.ReactNode }) => <>{children}</>
}))

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  // Why: the composer picks its submit modifier from the user agent; pin it to
  // the non-Mac branch so the test always drives Ctrl+Enter.
  vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue('Windows')
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  vi.restoreAllMocks()
})

function renderComposer(onSubmit: () => Promise<{ ok: true }>): HTMLTextAreaElement {
  act(() => {
    root.render(
      <RightPanelCommentComposer
        placeholder="댓글을 입력하세요"
        submitLabel="등록"
        onSubmit={onSubmit}
      />
    )
  })
  const textarea = container.querySelector('textarea')
  if (!textarea) {
    throw new Error('comment textarea not rendered')
  }
  return textarea
}

function typeBody(textarea: HTMLTextAreaElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
      textarea,
      value
    )
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function pressEnter(
  textarea: HTMLTextAreaElement,
  init?: KeyboardEventInit & { keyCode?: number }
): void {
  const event = new KeyboardEvent('keydown', {
    key: 'Enter',
    bubbles: true,
    cancelable: true,
    ctrlKey: true,
    ...init
  })
  if (init?.keyCode !== undefined) {
    Object.defineProperty(event, 'keyCode', { value: init.keyCode })
  }
  act(() => {
    textarea.dispatchEvent(event)
  })
}

describe('RightPanelCommentComposer IME Enter guard', () => {
  it('does not submit on the Ctrl+Enter that commits a CJK composition', () => {
    const onSubmit = vi.fn(async () => ({ ok: true }) as const)
    const textarea = renderComposer(onSubmit)
    typeBody(textarea, '확인했습니다')

    pressEnter(textarea, { isComposing: true })

    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('does not submit on a Ctrl+Enter reported as keyCode 229', () => {
    const onSubmit = vi.fn(async () => ({ ok: true }) as const)
    const textarea = renderComposer(onSubmit)
    typeBody(textarea, '확인했습니다')

    pressEnter(textarea, { keyCode: 229 })

    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('still submits on a plain Ctrl+Enter', () => {
    const onSubmit = vi.fn(async () => ({ ok: true }) as const)
    const textarea = renderComposer(onSubmit)
    typeBody(textarea, '확인했습니다')

    pressEnter(textarea)

    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit).toHaveBeenCalledWith('확인했습니다')
  })
})
