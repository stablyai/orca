// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { COMMENT_BODY_NONBLANK_SCAN_MAX_BYTES } from '@/lib/comment-body-submit-state'
import { DiffCommentPopover } from './DiffCommentPopover'

const roots: Root[] = []

async function renderPopover(args: {
  onCancel: () => void
  onSubmit?: (body: string) => Promise<void>
}): Promise<HTMLDivElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)

  await act(async () => {
    root.render(
      <DiffCommentPopover
        lineNumber={3}
        top={10}
        onCancel={args.onCancel}
        onSubmit={args.onSubmit ?? (async () => {})}
      />
    )
  })

  return container
}

// Why: the textarea is a controlled React input, so writing `.value` directly is
// invisible to React. Drive the change through the native value setter + an
// 'input' event the way React's synthetic onChange listens for it.
function typeInDraft(container: HTMLElement, value: string): void {
  const textarea = container.querySelector('textarea')
  if (!textarea) {
    throw new Error('textarea not found')
  }
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  setter?.call(textarea, value)
  textarea.dispatchEvent(new Event('input', { bubbles: true }))
}

async function clickOutside(): Promise<void> {
  await act(async () => {
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  })
}

describe('DiffCommentPopover outside-click draft preservation', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    roots.splice(0).forEach((root) => {
      act(() => root.unmount())
    })
    document.body.replaceChildren()
    vi.clearAllMocks()
  })

  it('keeps the popover open on outside-click when the draft has content', async () => {
    const onCancel = vi.fn()
    const container = await renderPopover({ onCancel })

    await act(async () => {
      typeInDraft(container, 'unsaved note')
    })
    await clickOutside()

    expect(onCancel).not.toHaveBeenCalled()
  })

  it('dismisses on outside-click when the draft is empty', async () => {
    const onCancel = vi.fn()
    await renderPopover({ onCancel })

    await clickOutside()

    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('dismisses on outside-click when the draft is only whitespace', async () => {
    const onCancel = vi.fn()
    const container = await renderPopover({ onCancel })

    await act(async () => {
      typeInDraft(container, '   ')
    })
    await clickOutside()

    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('keeps the popover open when non-whitespace text follows large leading whitespace', async () => {
    const onCancel = vi.fn()
    const container = await renderPopover({ onCancel })

    await act(async () => {
      typeInDraft(container, `${' '.repeat(COMMENT_BODY_NONBLANK_SCAN_MAX_BYTES + 1)}note`)
    })
    await clickOutside()

    expect(onCancel).not.toHaveBeenCalled()
  })

  it('still dismisses after the user clears a draft back to empty', async () => {
    const onCancel = vi.fn()
    const container = await renderPopover({ onCancel })

    await act(async () => {
      typeInDraft(container, 'typed then deleted')
    })
    await act(async () => {
      typeInDraft(container, '')
    })
    await clickOutside()

    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})
