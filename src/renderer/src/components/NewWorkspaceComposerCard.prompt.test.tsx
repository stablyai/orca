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
        settings: { defaultTuiAgent: null, disabledTuiAgents: [] },
        updateSettings: vi.fn(),
        projects: [],
        repos: []
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

vi.mock('@/components/new-workspace/SetProjectLocationDialog', () => ({
  SetProjectLocationDialog: () => null
}))

vi.mock('@/components/sparse/SparseCheckoutPresetSelect', () => ({
  default: () => null
}))

vi.mock('@/components/new-workspace/SmartWorkspaceNameField', () => ({
  default: () => <input aria-label="workspace name" />
}))

vi.mock('@/components/new-workspace/ProjectCombobox', () => ({
  default: () => <div data-testid="project-combobox" />
}))

function findPromptTextarea(container: HTMLElement): HTMLTextAreaElement | null {
  const label = [...container.querySelectorAll('label')].find(
    (candidate) => candidate.textContent?.trim() === 'Prompt'
  )
  const labelledId = label?.getAttribute('for')
  return labelledId ? (document.getElementById(labelledId) as HTMLTextAreaElement | null) : null
}

function typeInto(textarea: HTMLTextAreaElement, value: string): void {
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  act(() => {
    valueSetter?.call(textarea, value)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('NewWorkspaceComposerCard prompt field', () => {
  let container: HTMLDivElement | null = null

  afterEach(() => {
    container?.remove()
    container = null
    vi.clearAllMocks()
  })

  it('emits typed edits and stays outside the collapsed Advanced panel', async () => {
    const onAgentPromptChange = vi.fn()
    container = await renderCard({ quickAgent: 'claude', onAgentPromptChange })

    const prompt = findPromptTextarea(container)
    expect(prompt).toBeTruthy()
    expect(prompt?.disabled).toBe(false)
    expect(prompt?.closest('[aria-hidden="true"]')).toBeNull()

    typeInto(prompt as HTMLTextAreaElement, 'ship the parser fix')

    expect(onAgentPromptChange).toHaveBeenCalledWith('ship the parser fix')
  })

  it('disables the prompt when no agent will launch to receive it', async () => {
    container = await renderCard({ quickAgent: null })

    expect(findPromptTextarea(container)?.disabled).toBe(true)
  })
})
