// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { getDefaultSettings } from '../../../../shared/constants'
const mocks = vi.hoisted(
  (): { settings: GlobalSettings | null; agents: ReturnType<typeof vi.fn> } => ({
    settings: null,
    agents: vi.fn().mockResolvedValue(['claude', 'codex'])
  })
)
vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (select: (state: unknown) => unknown) => select({ settings: mocks.settings }),
    { getState: () => ({ settings: mocks.settings, ensureDetectedAgents: mocks.agents }) }
  )
}))
vi.mock('@/store/selectors', () => ({ useRepoById: () => null }))
vi.mock('@/runtime/local-runtime-capabilities', () => ({
  ensureLocalRuntimeCapabilities: async () => [],
  readLocalRuntimeCapabilitiesOrUnknown: () => []
}))
vi.mock('./source-control-launch-agent-args-applicability', () => ({
  sourceControlLaunchAppliesAgentArgs: () => false
}))
vi.mock('./use-source-control-launchable-agents', () => ({
  useSourceControlLaunchableAgents: () => ({
    detecting: false,
    refreshAgents: mocks.agents,
    refreshLaunchableAgents: mocks.agents,
    launchableAgents: ['claude', 'codex']
  })
}))
vi.mock('./useSavedSourceControlAgentActionAutoStart', () => ({
  useSavedSourceControlAgentActionAutoStart: () => ({ autoLaunchPending: false })
}))
vi.mock('./useSourceControlAgentActionStart', () => ({
  useSourceControlAgentActionStart: () => ({
    deliveryPlan: { status: 'idle' },
    resetDeliveryPlan: () => {},
    isStarting: false,
    handleStart: async () => {},
    startWithDetectedAgents: async () => true
  })
}))
import { useSourceControlAgentActionDialog } from './useSourceControlAgentActionDialog'
afterEach(cleanup)
it('keeps a default recipe and dormant choice through display changes, then records an actual edit', async () => {
  mocks.settings = { ...getDefaultSettings('/tmp/pr-30449'), defaultTuiAgent: 'codex' }
  const launchPreferences = {
    agentId: 'codex' as const,
    model: 'chosen',
    options: { effort: 'high' }
  }
  mocks.settings.sourceControlAi!.actions!.resolveConflicts = { agentId: null, launchPreferences }
  const { result, rerender } = renderHook(() =>
    useSourceControlAgentActionDialog({
      open: true,
      onOpenChange: () => {},
      actionId: 'resolveConflicts',
      title: '',
      description: '',
      baseCommandInput: 'fix',
      launchSource: 'source_control_recovery',
      savedAgentId: null
    })
  )
  await waitFor(() => expect(result.current.detecting).toBe(false))
  expect(result.current.selectedAgent).toBe('codex')
  act(() => result.current.onCommandTemplateChange('{basePrompt} edited'))
  mocks.settings = { ...mocks.settings, defaultTuiAgent: 'claude' }
  rerender()
  await waitFor(() => expect(result.current.detecting).toBe(false))
  expect(result.current.selectedAgent).toBe('claude')
  expect(result.current.recipe).toMatchObject({
    agentId: null,
    launchPreferences,
    commandInputTemplate: '{basePrompt} edited'
  })
  act(() => result.current.onSelectedAgentChange('codex'))
  expect(result.current.recipe).toMatchObject({ agentId: 'codex', launchPreferences })
  act(() => result.current.onSelectedAgentChange('claude'))
  expect(result.current.recipe.agentId).toBe('claude')
  expect(result.current.recipe.launchPreferences).toBeUndefined()
})
