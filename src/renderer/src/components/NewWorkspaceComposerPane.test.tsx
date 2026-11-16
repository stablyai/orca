// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type PaneRequest = { id: number; data: { initialRepoId?: string } }

const storeState: {
  activeModal: string
  workspaceComposerPaneRequest: PaneRequest | null
  closeWorkspaceComposerPane: ReturnType<typeof vi.fn>
} = {
  activeModal: 'none',
  workspaceComposerPaneRequest: null,
  closeWorkspaceComposerPane: vi.fn()
}

vi.mock('@/store', () => ({
  useAppStore: Object.assign((selector: (state: unknown) => unknown) => selector(storeState), {
    getState: () => storeState
  })
}))

vi.mock('@/components/NewWorkspaceComposerModal', () => ({
  // Seeds from modalData only on mount, like the real composer state.
  WorkspaceComposerBody: ({ modalData }: { modalData: { initialRepoId?: string } }) => (
    <textarea data-workspace-prompt-input="true" defaultValue={modalData.initialRepoId} />
  )
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

beforeEach(() => {
  storeState.activeModal = 'none'
  storeState.workspaceComposerPaneRequest = { id: 1, data: {} }
  storeState.closeWorkspaceComposerPane.mockReset()
})

afterEach(() => {
  act(() => {
    root?.unmount()
  })
  root = null
  document.body.innerHTML = ''
})

describe('NewWorkspaceComposerPane', () => {
  it('focuses the prompt on open', () => {
    const prompt = renderPane()
    expect(document.activeElement).toBe(prompt)
  })

  it('closes on Escape pressed inside the pane', () => {
    const prompt = renderPane()
    const event = pressEscape(prompt)
    expect(storeState.closeWorkspaceComposerPane).toHaveBeenCalledTimes(1)
    expect(event.defaultPrevented).toBe(true)
  })

  it('leaves an Escape a nested layer already handled alone', () => {
    const prompt = renderPane()
    prompt.addEventListener('keydown', (event) => event.preventDefault())
    pressEscape(prompt)
    expect(storeState.closeWorkspaceComposerPane).not.toHaveBeenCalled()
  })
})

describe('NewWorkspaceComposerPane Escape ownership', () => {
  it('ignores the Escape that cancels an IME composition', () => {
    const prompt = renderPane()
    pressEscape(prompt, { isComposing: true })
    expect(storeState.closeWorkspaceComposerPane).not.toHaveBeenCalled()
  })

  it('ignores Escape typed into another surface such as the sidebar', () => {
    renderPane()
    const sidebarInput = document.createElement('input')
    document.body.appendChild(sidebarInput)
    pressEscape(sidebarInput)
    expect(storeState.closeWorkspaceComposerPane).not.toHaveBeenCalled()
  })

  it('leaves Escape to a dialog opened over the pane', () => {
    storeState.activeModal = 'delete-worktree'
    const prompt = renderPane()
    pressEscape(prompt)
    expect(storeState.closeWorkspaceComposerPane).not.toHaveBeenCalled()
  })

  it('reseeds the composer when it is reopened for another project', () => {
    storeState.workspaceComposerPaneRequest = { id: 1, data: { initialRepoId: 'repo-1' } }
    renderPane()
    storeState.workspaceComposerPaneRequest = { id: 2, data: { initialRepoId: 'repo-2' } }
    act(() => {
      root?.render(<NewWorkspaceComposerPane />)
    })
    const prompt = document.querySelector<HTMLTextAreaElement>('[data-workspace-prompt-input]')
    expect(prompt?.value).toBe('repo-2')
  })
})
