// @vitest-environment happy-dom

import type * as RuntimeGitStatusClientModule from '@/runtime/runtime-git-status-client'
import path from 'node:path'
import React, { type ReactNode, useState, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { SourceControlActionRecipe } from '../../../../shared/source-control-ai-actions'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { Repo } from '../../../../shared/repo-types'
import type { RuntimeApi } from '../../../../preload/api/runtime-api'
import type { RuntimeRpcSuccess } from '../../../../shared/runtime-rpc-envelope'
import type { RuntimeStatus } from '../../../../shared/runtime-types'
import type { RuntimeEnvironmentStatus } from '../../../../shared/runtime-host-status'
import type { AgentLaunchSettings } from '../../../../shared/agent-launch-settings'
import { projectAgentLaunchSettings } from '../../../../shared/agent-launch-settings'
import { AGENT_LAUNCH_SETTINGS_CAPABILITY } from '../../../../shared/agent-launch-runtime-capability'
import { publicRuntimeEnvironment } from '@/runtime/paired-runtime-environment-test-fixture'
import { createCompatibleRuntimeStatusResponse } from '@/runtime/runtime-compatibility-test-fixture'
import { getRuntimeEnvironmentRevision } from '@/runtime/runtime-environment-revision'
import { clearRuntimeCompatibilityCacheForTests } from '@/runtime/runtime-rpc-client'
import { clearHostAgentMenuSettingsForTests } from '@/components/settings/use-host-agent-launch-preferences'
import type { TuiAgent } from '../../../../shared/tui-agent'

const mocks = vi.hoisted(() => ({
  ensureDetectedAgents: vi.fn(),
  ensureRemoteDetectedAgents: vi.fn(),
  ensureRuntimeDetectedAgents: vi.fn(),
  onOpenChange: vi.fn(),
  onSaveAgentDefault: vi.fn(),
  onLaunched: vi.fn(),
  onStart: vi.fn(),
  checkSourceControlAgentActionLaunch: vi.fn(),
  toastError: vi.fn(),
  mutationInFlight: vi.fn()
}))
vi.mock('@/runtime/runtime-git-status-client', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeGitStatusClientModule>()),
  getRuntimeGitMutationInFlight: mocks.mutationInFlight
}))
vi.mock('@/components/agent/AgentCombobox', () => ({
  default: ({ value }: { value: string | null }) =>
    React.createElement('div', { 'data-agent-value': value ?? '' })
}))
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children?: ReactNode }) =>
    open ? React.createElement('div', { 'data-dialog-open': 'true' }, children) : null,
  DialogContent: ({ children }: { children?: ReactNode }) =>
    React.createElement('div', null, children),
  DialogDescription: ({ children }: { children?: ReactNode }) =>
    React.createElement('p', null, children),
  DialogFooter: ({ children }: { children?: ReactNode }) =>
    React.createElement('div', null, children),
  DialogHeader: ({ children }: { children?: ReactNode }) =>
    React.createElement('div', null, children),
  DialogTitle: ({ children }: { children?: ReactNode }) => React.createElement('h2', null, children)
}))
vi.mock('@/components/ui/select', () => ({
  Select: ({ children }: { children?: ReactNode }) => React.createElement('div', null, children),
  SelectContent: ({ children }: { children?: ReactNode }) =>
    React.createElement('div', null, children),
  SelectItem: ({ children, value }: { children?: ReactNode; value: string }) =>
    React.createElement('div', { 'data-select-item': value }, children),
  SelectTrigger: ({ children }: { children?: ReactNode }) =>
    React.createElement('button', null, children),
  SelectValue: () => React.createElement('span')
}))
vi.mock('../source-control/SourceControlActionVariableChips', () => ({
  SourceControlActionVariableChips: () => React.createElement('div')
}))
vi.mock('@/lib/source-control-agent-action-launch-check', () => ({
  checkSourceControlAgentActionLaunch: mocks.checkSourceControlAgentActionLaunch
}))
vi.mock('sonner', () => ({
  toast: { error: mocks.toastError }
}))
import { useAppStore, type AppState } from '@/store'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import { SourceControlAgentActionDialog } from './SourceControlAgentActionDialog'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import { getRuntimeAgentInventoryKey } from '@/store/slices/runtime-agent-inventory-key'
import { deferred } from './source-control-hook-test-harness'
const recoveryContext = {
  target: { kind: 'local' as const },
  worktreeId: 'repo-1::/repo-1',
  worktreePath: '/repo-1'
}
let container: HTMLDivElement
let root: Root
let initialState: AppState
let previousApi: PropertyDescriptor | undefined
let installedTransport = false
type EnvironmentTransport = Pick<
  RuntimeApi['runtimeEnvironments'],
  'call' | 'subscribe' | 'cancelSubscription'
>
type PreferencesUnsubscribe = Awaited<ReturnType<EnvironmentTransport['subscribe']>>['unsubscribe']
const preferencesStreams: {
  callbacks: Parameters<EnvironmentTransport['subscribe']>[1]
  handle: Awaited<ReturnType<EnvironmentTransport['subscribe']>>
  subscriptionId: string | undefined
  unsubscribe: Mock<PreferencesUnsubscribe>
}[] = []
function settingsWithGlobalRecipe(
  recipe: SourceControlActionRecipe | null = {
    agentId: 'codex',
    commandInputTemplate: '{basePrompt}',
    agentArgs: ''
  },
  disabledTuiAgents: GlobalSettings['disabledTuiAgents'] = []
): GlobalSettings {
  const base = getDefaultSettings(path.resolve('tmp'))
  return {
    ...base,
    defaultTuiAgent: 'codex',
    disabledTuiAgents,
    sourceControlAi: {
      ...base.sourceControlAi!,
      enabled: true,
      agentId: 'codex',
      customAgentCommand: '',
      actions: recipe ? { resolveConflicts: recipe } : {}
    }
  }
}
function repoWithSavedRecipe(
  agentArgs = '',
  connectionId: string | null = null,
  executionHostId: Repo['executionHostId'] = undefined
): Repo {
  return {
    id: 'repo-1',
    path: '/repo-1',
    displayName: 'Repo 1',
    badgeColor: 'blue',
    addedAt: 0,
    connectionId,
    executionHostId,
    sourceControlAi: {
      enabled: true,
      actionOverrides: {
        resolveConflicts: {
          agentId: 'codex',
          commandInputTemplate: '{basePrompt}',
          agentArgs
        }
      }
    }
  }
}
function resetStore(settings: GlobalSettings, repos: Repo[] = []): void {
  useAppStore.setState(
    {
      ...initialState,
      settings,
      repos,
      ensureDetectedAgents: mocks.ensureDetectedAgents,
      ensureRemoteDetectedAgents: mocks.ensureRemoteDetectedAgents,
      ensureRuntimeDetectedAgents: mocks.ensureRuntimeDetectedAgents
    },
    true
  )
}
// The dialog reads the store's inventory, so the probes write it the way the real actions do.
function detects(ids: TuiAgent[]): void {
  mocks.ensureDetectedAgents.mockImplementation(async () => {
    useAppStore.setState({ detectedAgentIds: ids, localDetectedAgentIdsByContext: { host: ids } })
    return ids
  })
  mocks.ensureRemoteDetectedAgents.mockImplementation(async (connectionId: string) => {
    useAppStore.setState((state) => ({
      remoteDetectedAgentIds: { ...state.remoteDetectedAgentIds, [connectionId]: ids }
    }))
    return ids
  })
  mocks.ensureRuntimeDetectedAgents.mockImplementation(
    async (environmentId: string, worktreeId?: string) => {
      const key = getRuntimeAgentInventoryKey(environmentId, worktreeId)
      useAppStore.setState((state) => ({
        runtimeDetectedAgentIds: { ...state.runtimeDetectedAgentIds, [key]: ids }
      }))
      return ids
    }
  )
}
function renderControlledDialog(
  overrides: Partial<React.ComponentProps<typeof SourceControlAgentActionDialog>> = {},
  options: { strictMode?: boolean } = {}
): void {
  function Harness(): React.JSX.Element {
    const [open, setOpen] = useState(true)
    return (
      <SourceControlAgentActionDialog
        open={open}
        onOpenChange={(nextOpen) => {
          mocks.onOpenChange(nextOpen)
          setOpen(nextOpen)
        }}
        actionId="resolveConflicts"
        recoveryContext={recoveryContext}
        title="Launch agent"
        description="Review the launch recipe before starting."
        baseCommandInput="Resolve conflicts."
        savedCommandInputTemplate="{basePrompt}"
        savedAgentArgs=""
        launchSource="source_control_recovery"
        savedAgentId="codex"
        onSaveAgentDefault={mocks.onSaveAgentDefault}
        onLaunched={mocks.onLaunched}
        onStart={mocks.onStart}
        {...overrides}
      />
    )
  }

  act(() => {
    root.render(
      options.strictMode ? (
        <React.StrictMode>
          <Harness />
        </React.StrictMode>
      ) : (
        <Harness />
      )
    )
  })
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}
describe('SourceControlAgentActionDialog', () => {
  beforeEach(() => {
    setLocalRuntimeCapabilitiesForTests(null)
    ;(
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true
    initialState = useAppStore.getState()
    installedTransport = false
    preferencesStreams.length = 0
    clearHostAgentMenuSettingsForTests()
    clearRuntimeCompatibilityCacheForTests()
    vi.clearAllMocks()
    detects(['codex'])
    mocks.onStart.mockResolvedValue(true)
    mocks.mutationInFlight.mockResolvedValue({ inFlight: false })
    mocks.checkSourceControlAgentActionLaunch.mockReturnValue({ ok: true })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    resetStore(settingsWithGlobalRecipe())
  })
  afterEach(async () => {
    try {
      await act(async () => {
        root.unmount()
      })
      for (const stream of preferencesStreams) {
        expect(stream.unsubscribe).toHaveBeenCalledOnce()
        expect(stream.handle.sendBinary).not.toHaveBeenCalled()
      }
    } finally {
      container.remove()
      clearHostAgentMenuSettingsForTests()
      clearRuntimeCompatibilityCacheForTests()
      useAppStore.setState(initialState, true)
      setLocalRuntimeCapabilitiesForTests(null)
      if (installedTransport) {
        if (previousApi) {
          Object.defineProperty(window, 'api', previousApi)
        } else {
          Reflect.deleteProperty(window, 'api')
        }
      }
    }
  })
  it.each(['global', 'repo'])(
    'opens saved %s recipes for editing and Cancel starts nothing',
    async (scope) => {
      if (scope === 'repo') {
        resetStore(settingsWithGlobalRecipe(), [repoWithSavedRecipe()])
      }
      renderControlledDialog(scope === 'repo' ? { repoId: 'repo-1' } : {})
      await flushEffects()
      expect(container.textContent).toContain('Launch agent')
      expect(container.querySelector('textarea')?.value).toBe('{basePrompt}')
      const cancel = [...container.querySelectorAll('button')].find(
        (button) => button.textContent === 'Cancel'
      )!
      act(() => cancel.click())
      expect(mocks.onStart).not.toHaveBeenCalled()
      expect(mocks.onLaunched).not.toHaveBeenCalled()
    }
  )
  // Why (#21429): a paired server's workspace has no SSH connection on this client; its agents
  // are on the server, and this client's own list says nothing about them.
  it('detects agents on the paired server that owns the workspace', async () => {
    detects([])
    mocks.ensureRuntimeDetectedAgents.mockImplementation(async (environmentId, worktreeId) => {
      const key = getRuntimeAgentInventoryKey(environmentId, worktreeId)
      useAppStore.setState({ runtimeDetectedAgentIds: { [key]: ['codex'] } })
      return ['codex']
    })
    const settings = settingsWithGlobalRecipe()
    const status: RuntimeRpcSuccess<RuntimeStatus> =
      createCompatibleRuntimeStatusResponse('action-host')
    status.result.capabilities = [AGENT_LAUNCH_SETTINGS_CAPABILITY]
    const connected: RuntimeEnvironmentStatus = {
      status: status.result,
      checkedAt: 1,
      connectionGeneration: 1
    }
    const reply: RuntimeRpcSuccess<{ settings: AgentLaunchSettings }> = {
      id: 'preferences',
      ok: true,
      result: { settings: projectAgentLaunchSettings(settings) },
      _meta: { runtimeId: 'action-host' }
    }
    const revision = getRuntimeEnvironmentRevision('env-1')
    const transport: EnvironmentTransport = {
      call: vi.fn<EnvironmentTransport['call']>(async (args) => {
        expect(args).toEqual({
          selector: 'env-1',
          method: 'status.get',
          params: undefined,
          timeoutMs: 15000,
          expectedEnvironmentPairingRevision: revision,
          expectedEnvironmentRuntimeId: undefined
        })
        return status
      }),
      subscribe: vi.fn<EnvironmentTransport['subscribe']>(async (args, callbacks) => {
        expect(args).toEqual({
          selector: 'env-1',
          subscriptionId: expect.any(String),
          method: 'settings.getAgentLaunch',
          params: undefined,
          timeoutMs: 15000,
          expectedEnvironmentPairingRevision: revision,
          expectedEnvironmentRuntimeId: 'action-host'
        })
        const unsubscribe = vi.fn<PreferencesUnsubscribe>()
        const handle: Awaited<ReturnType<EnvironmentTransport['subscribe']>> = {
          unsubscribe,
          sendBinary: vi.fn()
        }
        preferencesStreams.push({
          callbacks,
          handle,
          subscriptionId: args.subscriptionId,
          unsubscribe
        })
        return handle
      }),
      cancelSubscription: vi.fn<EnvironmentTransport['cancelSubscription']>(
        async ({ subscriptionId }) => {
          const stream = preferencesStreams.find((entry) => entry.subscriptionId === subscriptionId)
          if (!stream) {
            throw new Error('Unknown preferences subscription')
          }
          stream.unsubscribe()
        }
      )
    }
    previousApi = Object.getOwnPropertyDescriptor(window, 'api')
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { runtimeEnvironments: transport }
    })
    installedTransport = true
    resetStore(settings, [repoWithSavedRecipe('', null, 'runtime:env-1')])
    useAppStore.setState({
      runtimeEnvironments: [publicRuntimeEnvironment({ id: 'env-1', runtimeId: 'action-host' })],
      runtimeStatusByEnvironmentId: new Map([['env-1', connected]]),
      worktreesByRepo: { 'repo-1': [makeWorktree({ id: 'repo-1::wt-1', repoId: 'repo-1' })] }
    })

    renderControlledDialog({ repoId: 'repo-1', worktreeId: 'repo-1::wt-1', connectionId: null })

    await vi.waitFor(() =>
      expect(mocks.ensureRuntimeDetectedAgents).toHaveBeenCalledWith('env-1', 'repo-1::wt-1')
    )
    await vi.waitFor(() => expect(preferencesStreams.length).toBeGreaterThan(0))
    await act(async () => {
      for (const stream of preferencesStreams) {
        stream.callbacks.onResponse(reply)
      }
    })
    await flushEffects()
    expect(mocks.onStart).not.toHaveBeenCalled()
    const start = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.toLowerCase().includes('start agent')
    )!
    await vi.waitFor(() => expect(start.disabled).toBe(false))
    await act(async () => start.click())
    await vi.waitFor(() => {
      expect(mocks.onStart).toHaveBeenCalledTimes(1)
      expect(mocks.onOpenChange).toHaveBeenCalledWith(false)
      expect(container.querySelector('[data-dialog-open]')).toBeNull()
    })
    expect(
      new Set([
        ...vi.mocked(transport.call).mock.calls.map(([args]) => args.method),
        ...vi.mocked(transport.subscribe).mock.calls.map(([args]) => args.method)
      ])
    ).toEqual(new Set(['status.get', 'settings.getAgentLaunch']))
    expect(transport.cancelSubscription).not.toHaveBeenCalled()
    expect(mocks.ensureRuntimeDetectedAgents).toHaveBeenCalledWith('env-1', 'repo-1::wt-1')
    expect(mocks.ensureDetectedAgents).not.toHaveBeenCalled()
  })
  it('cancels a manual launch during recovery admission', async () => {
    const check = deferred<{ inFlight: boolean }>()
    mocks.mutationInFlight.mockReturnValueOnce(check.promise)
    renderControlledDialog()
    await flushEffects()
    const start = [...container.querySelectorAll('button')].find((entry) =>
      entry.textContent?.toLowerCase().includes('start agent')
    )!
    act(() => start.click())
    await vi.waitFor(() => expect(mocks.mutationInFlight).toHaveBeenCalledOnce())
    const cancel = [...container.querySelectorAll('button')].find(
      (entry) => entry.textContent === 'Cancel'
    )!
    act(() => cancel.click())
    expect(mocks.onOpenChange).toHaveBeenCalledWith(false)
    await act(async () => check.resolve({ inFlight: false }))
    await flushEffects()
    expect(mocks.onStart).not.toHaveBeenCalled()
    expect(mocks.onLaunched).not.toHaveBeenCalled()
    expect(mocks.onSaveAgentDefault).not.toHaveBeenCalled()
  })

  it('cancels recovery when the editor unmounts during its host check', async () => {
    const check = deferred<{ inFlight: boolean }>()
    mocks.mutationInFlight.mockReturnValueOnce(check.promise)
    renderControlledDialog()
    await flushEffects()
    const start = [...container.querySelectorAll('button')].find((entry) =>
      entry.textContent?.toLowerCase().includes('start agent')
    )!
    act(() => start.click())
    await vi.waitFor(() => expect(mocks.mutationInFlight).toHaveBeenCalledOnce())
    act(() => root.render(null))
    await act(async () => check.resolve({ inFlight: false }))
    await flushEffects()
    expect(mocks.onStart).not.toHaveBeenCalled()
    expect(mocks.onLaunched).not.toHaveBeenCalled()
  })

  it('blocks manual start while Git is running and allows an explicit retry', async () => {
    resetStore(settingsWithGlobalRecipe(null))
    renderControlledDialog()
    await vi.waitFor(() => expect(container.textContent?.toLowerCase()).toContain('start agent'))
    await flushEffects()
    const button = Array.from(container.querySelectorAll('button')).find((entry) =>
      entry.textContent?.toLowerCase().includes('start agent')
    )
    if (!button) {
      throw new Error('Missing start button')
    }
    mocks.mutationInFlight.mockResolvedValue({ inFlight: true })
    act(() => button.click())
    await flushEffects()

    expect(button.disabled).toBe(false)
    expect(mocks.onStart).not.toHaveBeenCalled()
    expect(mocks.onLaunched).not.toHaveBeenCalled()
    expect(mocks.onOpenChange).not.toHaveBeenCalledWith(false)

    mocks.mutationInFlight.mockResolvedValue({ inFlight: false })
    await flushEffects()
    expect(button.disabled).toBe(false)
    act(() => button.click())
    await vi.waitFor(() => expect(mocks.onStart).toHaveBeenCalledTimes(1))
  })
})
