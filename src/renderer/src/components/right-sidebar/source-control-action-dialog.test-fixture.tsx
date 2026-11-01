import { EVERY_AGENT_CHAT } from '../../../../shared/native-chat/every-agent-chat.test-fixture'
import { terminalSessionOptionInputs } from '../../../../shared/tui-agent-launch-command'
import { buildAgentStartupPlan } from '../../../../shared/tui-agent-startup'
import { resolveSourceControlActionRecipe } from '../../../../shared/source-control-ai-operation-policy'
import { TooltipProvider } from '@/components/ui/tooltip'
import {
  SourceControlAgentActionDialog,
  type SourceControlAgentActionDialogProps
} from './SourceControlAgentActionDialog'
import type { RunSourceControlAgentActionStartArgs } from './runSourceControlAgentActionStart'
import type { SourceControlActionRecipe } from '../../../../shared/source-control-ai-actions'
import type { Repo } from '../../../../shared/repo-types'
import { normalizeRepoSourceControlAiOverrides } from '../../../../shared/source-control-ai'
import { saveSourceControlAiActionRecipeForTarget } from './source-control/ai/recipe-persistence'
import { TEST_REPO } from '@/store/slices/worktrees-slice-test-fixtures'
import { getDefaultSettings } from '../../../../shared/constants'
import { useAppStore } from '@/store'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import { AGENT_LAUNCH_SURFACE_RUNTIME_CAPABILITY as SURFACE } from '../../../../shared/agent-launch-runtime-capability'
import {
  STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY as CLIENT,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY as CHAT
} from '../../../../shared/protocol-version'
import { normalizeSourceControlActionRecipe } from '../../../../shared/source-control-ai-actions'
import { useSourceControlAgentActionDialog } from './useSourceControlAgentActionDialog'
import {
  render,
  renderHook,
  screen,
  fireEvent,
  waitFor,
  type RenderResult,
  type RenderHookResult
} from '@testing-library/react'
import { expect, vi, type Mock } from 'vitest'

export type SaveAction = NonNullable<SourceControlAgentActionDialogProps['onSaveAgentDefault']>

type MountedSourceDialog = {
  view: RenderResult
  mount: () => RenderResult
  persist: Mock<SaveAction>
  onStart: Mock<NonNullable<RunSourceControlAgentActionStartArgs['onStart']>>
  props: SourceControlAgentActionDialogProps
  repo: Repo
}

type RenderedSourceDialog = RenderHookResult<
  ReturnType<typeof useSourceControlAgentActionDialog>,
  unknown
> & {
  onStart: Mock
  onSaveAgentDefault: Mock
  launchPreferences: NonNullable<SourceControlActionRecipe['launchPreferences']>
}

export function mountSourceDialog(
  global: SourceControlActionRecipe,
  own: SourceControlActionRecipe,
  save?: SaveAction,
  onStart = vi
    .fn<NonNullable<RunSourceControlAgentActionStartArgs['onStart']>>()
    .mockResolvedValue(true),
  scope: 'global' | 'repo' = 'repo'
): MountedSourceDialog {
  const settings = {
    ...getDefaultSettings('/tmp/fc1-action'),
    defaultTuiAgent: 'claude' as const,
    nativeChatProviders: EVERY_AGENT_CHAT,
    agentPermissionDefault: 'own' as const
  }
  settings.sourceControlAi!.actions = { resolveConflicts: global }
  const repo = { ...TEST_REPO, sourceControlAi: { actionOverrides: { resolveConflicts: own } } }
  useAppStore.setState({
    settings,
    repos: [repo],
    detectedAgentIds: ['claude', 'codex'],
    localDetectedAgentIdsByContext: { host: ['claude', 'codex'] }
  })
  setLocalRuntimeCapabilitiesForTests([CHAT, CLIENT, SURFACE])
  const persist = vi.fn<SaveAction>(
    save ??
      (async (target, actionId, recipe) => {
        await saveSourceControlAiActionRecipeForTarget({
          getStoreState: useAppStore.getState,
          target,
          actionId,
          recipe,
          updateSettings: async (patch) => {
            useAppStore.setState((state) => ({ settings: { ...state.settings!, ...patch } }))
          },
          updateRepo: async (id, patch) => {
            useAppStore.setState((state) => ({
              repos: state.repos.map((row) =>
                row.id === id
                  ? {
                      ...row,
                      sourceControlAi: normalizeRepoSourceControlAiOverrides(patch.sourceControlAi)
                    }
                  : row
              )
            }))
            return true
          }
        })
      })
  )
  const props = {
    open: true,
    onOpenChange: vi.fn(),
    actionId: 'resolveConflicts' as const,
    title: 'Resolve',
    description: '',
    baseCommandInput: 'fix',
    launchSource: 'source_control_recovery' as const,
    repoId: scope === 'repo' ? repo.id : undefined,
    connectionId: null,
    onStart,
    onSaveAgentDefault: persist
  }
  const mount = () =>
    render(<SourceControlAgentActionDialog {...props} />, { wrapper: TooltipProvider })
  return { view: mount(), mount, persist, onStart, props, repo }
}

export async function pickDialogAgent(label: string, terminal: boolean) {
  await waitFor(() =>
    expect(screen.getAllByRole('combobox')[0].hasAttribute('disabled')).toBe(false)
  )
  fireEvent.click(screen.getAllByRole('combobox')[0])
  if (terminal) {
    fireEvent.click(await screen.findByRole('button', { name: `Start ${label} in a terminal` }))
  } else {
    const row = screen.getAllByRole('option').find((item) => item.textContent?.startsWith(label))
    if (!row) {
      throw new Error(`Missing agent row ${label}`)
    }
    fireEvent.click(row)
  }
}

export function renderDialog(
  chat: boolean,
  capable = true,
  initialRecipe?: SourceControlActionRecipe
): RenderedSourceDialog {
  const settings = { ...getDefaultSettings('/tmp/pr-3'), defaultTuiAgent: 'claude' as const }
  const launchPreferences = normalizeSourceControlActionRecipe(
    { launchPreferences: { agentId: 'codex', model: 'chosen' } },
    true
  )!.launchPreferences!
  settings.sourceControlAi!.actions = { resolveConflicts: { agentId: null, launchPreferences } }
  useAppStore.setState({
    settings: { ...settings, nativeChatProviders: chat ? EVERY_AGENT_CHAT : {} },
    detectedAgentIds: ['claude', 'codex'],
    localDetectedAgentIdsByContext: { host: ['claude', 'codex'] }
  })
  setLocalRuntimeCapabilitiesForTests([CHAT, CLIENT, ...(capable ? [SURFACE] : [])])
  const onStart = vi.fn().mockResolvedValue(true)
  const onSaveAgentDefault = vi.fn()
  const view = renderHook(() =>
    useSourceControlAgentActionDialog({
      open: true,
      initialRecipe,
      onOpenChange: () => {},
      actionId: 'resolveConflicts',
      title: '',
      description: '',
      baseCommandInput: 'fix',
      launchSource: 'source_control_recovery',
      savedAgentId: null,
      onStart,
      onSaveAgentDefault
    })
  )
  return { ...view, onStart, onSaveAgentDefault, launchPreferences }
}

export function freshDialogRecipe(repoId: string) {
  const state = useAppStore.getState()
  return resolveSourceControlActionRecipe({
    settings: state.settings,
    repo: state.repos.find((row) => row.id === repoId),
    actionId: 'resolveConflicts'
  })
}

export async function pickDialogSaveTarget(label: string) {
  fireEvent.click(screen.getAllByRole('combobox')[1])
  fireEvent.click(await screen.findByRole('option', { name: label }))
}

export function submittedActionStartupPlan(
  submitted: Parameters<NonNullable<RunSourceControlAgentActionStartArgs['onStart']>>[0]
) {
  const { agent, agentArgs, sessionOptions } = submitted
  return buildAgentStartupPlan({
    agent,
    prompt: 'fix',
    platform: 'darwin',
    shell: 'posix',
    cmdOverrides: {},
    agentArgs,
    ...terminalSessionOptionInputs({ agent, agentArgs, sessionOptions, shell: 'posix' })
  })
}
