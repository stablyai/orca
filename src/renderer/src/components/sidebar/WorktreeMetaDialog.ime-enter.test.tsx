// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import WorktreeMetaDialog from './WorktreeMetaDialog'
import { TooltipProvider } from '@/components/ui/tooltip'

const initialState = useAppStore.getInitialState()
let root: Root | null = null
let container: HTMLDivElement | null = null

type UpdateWorktreeMeta = AppState['updateWorktreeMeta']

async function renderDialog(updateWorktreeMeta: UpdateWorktreeMeta): Promise<void> {
  useAppStore.setState({
    activeModal: 'edit-meta',
    modalData: { worktreeId: 'wt-1', currentDisplayName: 'wt', currentComment: '' },
    updateWorktreeMeta
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(
      <TooltipProvider>
        <WorktreeMetaDialog />
      </TooltipProvider>
    )
  })
}

function getCommentTextarea(): HTMLTextAreaElement {
  const textarea = document.body.querySelector('textarea')
  if (!textarea) {
    throw new Error('comment textarea not found')
  }
  return textarea
}

function dispatchKey(el: HTMLElement, type: 'keydown' | 'keyup', init: KeyboardEventInit): void {
  const event = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init })
  Object.defineProperty(event, 'keyCode', { value: init.keyCode })
  act(() => {
    el.dispatchEvent(event)
  })
}

function typeComment(textarea: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set as (
    this: HTMLTextAreaElement,
    v: string
  ) => void
  act(() => {
    setter.call(textarea, value)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('WorktreeMetaDialog comment IME Enter ownership', () => {
  beforeEach(() => {
    useAppStore.setState(initialState, true)
  })

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    root = null
    container = null
  })

  // Why: the comment field takes free CJK prose, and its plain-Enter save is reachable by the
  // unmarked Enter the IME redispatches after compositionEnd.
  it('does not save on the recorded Korean Enter redispatch', async () => {
    const updateWorktreeMeta = vi.fn<UpdateWorktreeMeta>(
      async () => ({ ok: true }) as Awaited<ReturnType<UpdateWorktreeMeta>>
    )
    await renderDialog(updateWorktreeMeta)
    const textarea = getCommentTextarea()
    typeComment(textarea, '테스')

    act(() => textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })))
    dispatchKey(textarea, 'keydown', { key: 'Process', keyCode: 229, isComposing: true })
    act(() => textarea.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })))
    dispatchKey(textarea, 'keydown', { key: 'Enter', keyCode: 13, isComposing: false })
    dispatchKey(textarea, 'keyup', { key: 'Process', keyCode: 229 })
    dispatchKey(textarea, 'keyup', { key: 'Enter', keyCode: 13 })

    expect(updateWorktreeMeta).not.toHaveBeenCalled()
  })

  // Why: this handler also accepts a Cmd/Ctrl+Enter chord, and the carry token owns
  // modifier-carrying Enters — a held modifier must not lose the user's deliberate save.
  it('saves when the modifier is held through the confirm redispatch', async () => {
    const updateWorktreeMeta = vi.fn<UpdateWorktreeMeta>(
      async () => ({ ok: true }) as Awaited<ReturnType<UpdateWorktreeMeta>>
    )
    await renderDialog(updateWorktreeMeta)
    const textarea = getCommentTextarea()
    typeComment(textarea, '테스')

    act(() => textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })))
    dispatchKey(textarea, 'keydown', {
      key: 'Enter',
      keyCode: 13,
      isComposing: true,
      ctrlKey: true
    })
    act(() => textarea.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })))
    dispatchKey(textarea, 'keydown', {
      key: 'Enter',
      keyCode: 13,
      isComposing: false,
      ctrlKey: true
    })

    expect(updateWorktreeMeta).toHaveBeenCalled()
  })

  it('does not save on a chord pressed mid-composition', async () => {
    const updateWorktreeMeta = vi.fn<UpdateWorktreeMeta>(
      async () => ({ ok: true }) as Awaited<ReturnType<UpdateWorktreeMeta>>
    )
    await renderDialog(updateWorktreeMeta)
    const textarea = getCommentTextarea()
    typeComment(textarea, '테스')

    act(() => textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })))
    dispatchKey(textarea, 'keydown', {
      key: 'Enter',
      keyCode: 13,
      isComposing: true,
      ctrlKey: true
    })

    expect(updateWorktreeMeta).not.toHaveBeenCalled()
  })

  it('saves on ordinary Enter', async () => {
    const updateWorktreeMeta = vi.fn<UpdateWorktreeMeta>(
      async () => ({ ok: true }) as Awaited<ReturnType<UpdateWorktreeMeta>>
    )
    await renderDialog(updateWorktreeMeta)
    const textarea = getCommentTextarea()
    typeComment(textarea, 'note')

    dispatchKey(textarea, 'keydown', { key: 'Enter', keyCode: 13, isComposing: false })

    expect(updateWorktreeMeta).toHaveBeenCalled()
  })
})
