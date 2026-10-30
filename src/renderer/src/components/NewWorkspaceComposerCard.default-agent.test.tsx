// @vitest-environment happy-dom
import type { ReactNode } from 'react'
import { act } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { getDefaultSettings } from '../../../shared/constants'
import { renderCard, unmountCard } from './NewWorkspaceComposerCard.test-fixture'

vi.mock('@/components/contextual-tours/use-contextual-tour', () => ({
  useContextualTour: () => {}
}))
vi.mock('@/components/new-workspace/NewWorkspaceComposerProjectSection', () => ({
  NewWorkspaceComposerProjectSection: () => null
}))
vi.mock('@/components/new-workspace/NewWorkspaceComposerNameSection', () => ({
  NewWorkspaceComposerNameSection: () => null
}))
vi.mock('@/components/new-workspace/NewWorkspaceComposerAdvancedSection', () => ({
  NewWorkspaceComposerAdvancedSection: () => null
}))
vi.mock('@/components/sidebar/AddRemoteHostDialog', () => ({ AddRemoteHostDialog: () => null }))
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))
vi.mock('@/components/agent/AgentCombobox', () => ({
  default: ({
    defaultAgent,
    onSetDefault
  }: {
    defaultAgent?: string | null
    onSetDefault?: (agent: 'codex') => void
  }) => (
    <button type="button" data-default-agent={defaultAgent} onClick={() => onSetDefault?.('codex')}>
      Agent picker
    </button>
  )
}))

const initial = useAppStore.getState()
let container: HTMLDivElement | undefined
afterEach(() => {
  if (container) {
    unmountCard(container)
  }
  useAppStore.setState(initial, true)
})

it('marks the global default beside the action that changes global settings', async () => {
  const updateSettings = vi.fn().mockResolvedValue(undefined)
  useAppStore.setState({
    settings: { ...getDefaultSettings('/test'), defaultTuiAgent: 'claude' },
    updateSettings,
    projects: [
      {
        id: 'B',
        displayName: 'B',
        badgeColor: '',
        sourceRepoIds: ['repo-b'],
        defaultTuiAgent: 'opencode',
        createdAt: 0,
        updatedAt: 0
      }
    ]
  })
  container = await renderCard({ selectedRepoProjectId: 'B' })
  const picker = container.querySelector<HTMLButtonElement>('[data-default-agent]')
  expect(picker?.dataset.defaultAgent).toBe('claude')
  act(() => picker?.click())
  expect(updateSettings).toHaveBeenCalledWith({
    defaultTuiAgent: 'codex',
    newWorkspaceSetupOnly: false
  })
})
