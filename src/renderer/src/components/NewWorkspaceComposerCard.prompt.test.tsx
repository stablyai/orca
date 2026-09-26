// @vitest-environment happy-dom

import React, { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderCard } from './NewWorkspaceComposerCard.test-fixture'

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: unknown) => unknown) =>
      selector({
        closeModal: vi.fn(),
        openModal: vi.fn(),
        openSettingsPage: vi.fn(),
        openSettingsTarget: vi.fn(),
        setRuntimeEnvironmentStatus: vi.fn(),
        activeModal: 'new-workspace-composer',
        settings: {
          defaultTuiAgent: null,
          disabledTuiAgents: [],
          experimentalPromptFirstComposer: true
        },
        updateSettings: vi.fn(),
        projects: [],
        repos: [],
        worktreesByRepo: {}
      }),
    { getState: () => ({}) }
  )
}))

vi.mock('@/components/contextual-tours/use-contextual-tour', () => ({
  useContextualTour: vi.fn()
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>
}))

vi.mock('@/components/agent/AgentCombobox', () => ({
  default: () => <button type="button">Agent picker</button>
}))

vi.mock('@/components/sidebar/AddRemoteHostDialog', () => ({
  AddRemoteHostDialog: () => null
}))

vi.mock('@/components/new-workspace/SmartWorkspaceNameField', () => ({
  default: () => <input aria-label="workspace name" />
}))

vi.mock('@/components/new-workspace/ProjectCombobox', () => ({
  default: () => <div data-testid="project-combobox" />
}))

vi.mock('@/components/new-workspace/RunTargetCombobox', () => ({
  default: () => <div data-testid="run-target-combobox" />
}))

function getPromptInput(container: HTMLElement): HTMLTextAreaElement {
  const input = container.querySelector<HTMLTextAreaElement>('[data-workspace-prompt-input="true"]')
  if (!input) {
    throw new Error('prompt textarea not rendered')
  }
  return input
}

function pressEnter(input: HTMLTextAreaElement, init: KeyboardEventInit = {}): void {
  act(() => {
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init })
    )
  })
}

describe('NewWorkspaceComposerCard prompt', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('renders the prompt textarea before the project picker', async () => {
    const container = await renderCard({ quickAgent: 'claude' })
    const prompt = getPromptInput(container)
    const project = container.querySelector('[data-testid="project-combobox"]')
    expect(project).not.toBeNull()
    expect(prompt.compareDocumentPosition(project!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('emits typed text through onAgentPromptChange', async () => {
    const onAgentPromptChange = vi.fn()
    const container = await renderCard({ quickAgent: 'claude', onAgentPromptChange })
    const prompt = getPromptInput(container)
    act(() => {
      // Why: React's value tracker ignores a direct .value write; the prototype setter bypasses it.
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
        prompt,
        'fix the flaky test'
      )
      prompt.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(onAgentPromptChange).toHaveBeenCalledWith('fix the flaky test')
  })

  it('submits on plain Enter and keeps Shift+Enter as a newline', async () => {
    const onCreate = vi.fn()
    const container = await renderCard({ quickAgent: 'claude', onCreate })
    const prompt = getPromptInput(container)
    pressEnter(prompt, { shiftKey: true })
    expect(onCreate).not.toHaveBeenCalled()
    pressEnter(prompt)
    expect(onCreate).toHaveBeenCalledTimes(1)
  })

  it('leaves Cmd/Ctrl+Enter to the screen-level submit shortcut', async () => {
    const onCreate = vi.fn()
    const container = await renderCard({ quickAgent: 'claude', onCreate })
    const prompt = getPromptInput(container)
    pressEnter(prompt, { metaKey: true })
    pressEnter(prompt, { ctrlKey: true })
    expect(onCreate).not.toHaveBeenCalled()
  })

  it('ignores Alt+Enter like the screen-level submit shortcut does', async () => {
    const onCreate = vi.fn()
    const container = await renderCard({ quickAgent: 'claude', onCreate })
    pressEnter(getPromptInput(container), { altKey: true })
    expect(onCreate).not.toHaveBeenCalled()
  })

  it('does not submit the Enter that confirms an IME composition', async () => {
    const onCreate = vi.fn()
    const container = await renderCard({ quickAgent: 'claude', onCreate })
    pressEnter(getPromptInput(container), { isComposing: true })
    expect(onCreate).not.toHaveBeenCalled()
  })

  it('does not submit while creation is disabled', async () => {
    const onCreate = vi.fn()
    const container = await renderCard({ quickAgent: 'claude', onCreate, createDisabled: true })
    pressEnter(getPromptInput(container))
    expect(onCreate).not.toHaveBeenCalled()
  })

  it('disables the textarea when no agent is selected', async () => {
    const container = await renderCard({ quickAgent: null })
    expect(getPromptInput(container).disabled).toBe(true)
  })
})
