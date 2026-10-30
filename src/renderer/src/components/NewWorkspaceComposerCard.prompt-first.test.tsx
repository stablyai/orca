// @vitest-environment happy-dom

import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderCard, unmountCard } from './NewWorkspaceComposerCard.test-fixture'

const settings = vi.hoisted(() => ({ promptFirstComposer: false }))

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: unknown) => unknown) =>
      selector({
        openModal: vi.fn(),
        activeModal: 'new-workspace-composer',
        settings: { defaultTuiAgent: null, disabledTuiAgents: [], ...settings },
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

vi.mock('@/components/new-workspace/SmartWorkspaceNameField', () => ({
  default: () => <input aria-label="workspace name" />
}))

vi.mock('@/components/new-workspace/ProjectCombobox', () => ({
  default: () => <div />
}))

const PROMPT_INPUT = '[data-workspace-prompt-input="true"]'

describe('NewWorkspaceComposerCard prompt-first setting', () => {
  let container: HTMLDivElement | null = null

  afterEach(() => {
    if (container) {
      unmountCard(container)
    }
    container = null
  })

  it('hides the prompt box while the setting is off', async () => {
    settings.promptFirstComposer = false
    container = await renderCard({ quickAgent: 'claude' })
    expect(container.querySelector(PROMPT_INPUT)).toBeNull()
  })

  it('shows the prompt box while the setting is on', async () => {
    settings.promptFirstComposer = true
    container = await renderCard({ quickAgent: 'claude' })
    expect(container.querySelector(PROMPT_INPUT)).not.toBeNull()
  })
  it('moves the create button into the prompt box while the setting is on', async () => {
    settings.promptFirstComposer = true
    container = await renderCard({ quickAgent: 'claude', primaryActionLabel: 'Create worktree' })
    const createButtons = Array.from(container.querySelectorAll('button')).filter(
      (button) =>
        button.getAttribute('aria-label') === 'Create worktree' ||
        button.textContent?.includes('Create worktree')
    )
    expect(createButtons).toHaveLength(1)
    const promptBox = container.querySelector(PROMPT_INPUT)?.parentElement
    expect(promptBox?.contains(createButtons[0])).toBe(true)
  })
})
