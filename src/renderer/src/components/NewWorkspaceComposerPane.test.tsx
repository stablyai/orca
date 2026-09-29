// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const storeState: {
  activeModal: string
  activeWorktreeId: string | null
  modalData: undefined
  closeModal: ReturnType<typeof vi.fn>
} = {
  activeModal: 'new-workspace-composer',
  activeWorktreeId: 'wt-1',
  modalData: undefined,
  closeModal: vi.fn()
}

vi.mock('@/store', () => ({
  useAppStore: Object.assign((selector: (state: unknown) => unknown) => selector(storeState), {
    getState: () => storeState
  })
}))

vi.mock('@/components/NewWorkspaceComposerModal', () => ({
  WorkspaceComposerBody: () => <textarea data-workspace-prompt-input="true" />
}))

import NewWorkspaceComposerPane from './NewWorkspaceComposerPane'

let root: Root | null = null

function renderPane(): HTMLTextAreaElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root?.render(<NewWorkspaceComposerPane />)
  })
  const prompt = container.querySelector<HTMLTextAreaElement>('[data-workspace-prompt-input]')
  if (!prompt) {
    throw new Error('prompt textarea not rendered')
  }
  return prompt
}

function pressEscape(target: EventTarget, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: 'Escape',
    bubbles: true,
    cancelable: true,
    ...init
  })
  act(() => {
    target.dispatchEvent(event)
  })
  return event
}

describe('NewWorkspaceComposerPane', () => {
  beforeEach(() => {
    storeState.activeModal = 'new-workspace-composer'
    storeState.activeWorktreeId = 'wt-1'
    storeState.closeModal.mockReset()
  })

  afterEach(() => {
    act(() => {
      root?.unmount()
    })
    root = null
    document.body.innerHTML = ''
  })

  it('focuses the prompt on open', () => {
    const prompt = renderPane()
    expect(document.activeElement).toBe(prompt)
  })

  it('closes on Escape pressed inside the pane', () => {
    const prompt = renderPane()
    const event = pressEscape(prompt)
    expect(storeState.closeModal).toHaveBeenCalledTimes(1)
    expect(event.defaultPrevented).toBe(true)
  })

  it('leaves an Escape a nested layer already handled alone', () => {
    const prompt = renderPane()
    prompt.addEventListener('keydown', (event) => event.preventDefault())
    pressEscape(prompt)
    expect(storeState.closeModal).not.toHaveBeenCalled()
  })

  it('ignores the Escape that cancels an IME composition', () => {
    const prompt = renderPane()
    pressEscape(prompt, { isComposing: true })
    expect(storeState.closeModal).not.toHaveBeenCalled()
  })

  it('ignores Escape typed into another surface such as the sidebar', () => {
    renderPane()
    const sidebarInput = document.createElement('input')
    document.body.appendChild(sidebarInput)
    pressEscape(sidebarInput)
    expect(storeState.closeModal).not.toHaveBeenCalled()
  })

  it('closes when the active workspace changes', () => {
    renderPane()
    storeState.activeWorktreeId = 'wt-2'
    act(() => {
      root?.render(<NewWorkspaceComposerPane />)
    })
    expect(storeState.closeModal).toHaveBeenCalledTimes(1)
  })
})
