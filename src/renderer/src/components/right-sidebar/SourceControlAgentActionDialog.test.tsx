// @vitest-environment happy-dom

import type * as RuntimeGitStatusClientModule from '@/runtime/runtime-git-status-client'
import path from 'node:path'
import React, { type ReactNode, useState, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import type { SourceControlActionRecipe } from '../../../../shared/source-control-ai-actions'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { Repo } from '../../../../shared/repo-types'
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
import { runtimeStatusEntry } from '@/runtime/server-layout-frames.test-fixture'
import { deferred } from './source-control-hook-test-harness'
const recoveryContext = {
  target: { kind: 'local' as const },
  worktreeId: 'repo-1::/repo-1',
  worktreePath: '/repo-1'
}
let container: HTMLDivElement
let root: Root
let initialState: AppState
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

function land(inventory: Partial<AppState>): TuiAgent[] {
  useAppStore.setState(inventory)
  return ['codex']
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
    vi.clearAllMocks()
    mocks.ensureDetectedAgents.mockImplementation(async () =>
      land({ localDetectedAgentIdsByContext: { host: ['codex'] } })
    )
    mocks.ensureRemoteDetectedAgents.mockImplementation(async (id: string) =>
      land({ remoteDetectedAgentIds: { [id]: ['codex'] } })
    )
    mocks.ensureRuntimeDetectedAgents.mockImplementation(async (env: string, wt: string) =>
      land({ runtimeDetectedAgentIds: { [getRuntimeAgentInventoryKey(env, wt)]: ['codex'] } })
    )
    mocks.onStart.mockResolvedValue(true)
    mocks.mutationInFlight.mockResolvedValue({ inFlight: false })
    mocks.checkSourceControlAgentActionLaunch.mockReturnValue({ ok: true })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    resetStore(settingsWithGlobalRecipe())
  })
  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
    useAppStore.setState(initialState, true)
    setLocalRuntimeCapabilitiesForTests(null)
  })
  it('hides the dialog and auto-starts once when the saved global launch recipe matches', async () => {
    renderControlledDialog()
    expect(container.textContent).not.toContain('Launch agent')
    await vi.waitFor(() => expect(mocks.onStart).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(mocks.onOpenChange).toHaveBeenCalledWith(false))
    expect(mocks.ensureDetectedAgents).toHaveBeenCalledTimes(1)
    expect(mocks.onStart).toHaveBeenCalledWith({
      agent: 'codex',
      commandInput: 'Resolve conflicts.',
      agentArgs: '--dangerously-bypass-approvals-and-sandbox'
    })
    expect(mocks.onLaunched).toHaveBeenCalledTimes(1)
    expect(mocks.onSaveAgentDefault).not.toHaveBeenCalled()
    expect(container.textContent).not.toContain('Launch agent')
  })
  it('auto-starts a sparse repo recipe without giving it inherited model ownership', async () => {
    const settings = settingsWithGlobalRecipe({
      agentId: 'codex',
      commandInputTemplate: '{basePrompt}',
      launchPreferences: { agentId: 'codex', model: 'gpt-5.6-terra' }
    })
    const repo = repoWithSavedRecipe()
    const sparse = { agentArgs: '--model gpt-5.6-sol' }
    repo.sourceControlAi = { actionOverrides: { resolveConflicts: sparse } }
    resetStore(settings, [repo])
    renderControlledDialog({ repoId: 'repo-1', savedAgentArgs: sparse.agentArgs })
    expect(container.textContent).not.toContain('Launch agent')
    await vi.waitFor(() => expect(mocks.onStart).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(mocks.onOpenChange).toHaveBeenCalledWith(false))
    expect(mocks.onStart).toHaveBeenCalledWith({
      agent: 'codex',
      commandInput: 'Resolve conflicts.',
      agentArgs: `--dangerously-bypass-approvals-and-sandbox ${sparse.agentArgs}`,
      sessionOptions: { model: 'gpt-5.6-terra' },
      sessionOptionsYieldToAgentArgs: true
    })
    expect(mocks.onSaveAgentDefault).not.toHaveBeenCalled()
    expect(repo.sourceControlAi.actionOverrides?.resolveConflicts).toEqual(sparse)
    expect(container.textContent).not.toContain('Launch agent')
  })
  it('keeps saved arguments on a prospective SSH terminal launch', async () => {
    setLocalRuntimeCapabilitiesForTests([STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY])
    const recipe = {
      agentId: 'codex' as const,
      commandInputTemplate: '{basePrompt}',
      agentArgs: '--model saved'
    }
    resetStore(
      {
        ...settingsWithGlobalRecipe(null),
        experimentalNativeChat: true
      },
      [repoWithSavedRecipe('--model saved', 'build-box', 'ssh:build-box')]
    )

    renderControlledDialog({
      repoId: 'repo-1',
      connectionId: 'build-box',
      savedAgentArgs: recipe.agentArgs
    })

    await vi.waitFor(() => expect(mocks.onStart).toHaveBeenCalledTimes(1))
    expect(mocks.onStart).toHaveBeenCalledWith({
      agent: 'codex',
      commandInput: 'Resolve conflicts.',
      agentArgs: '--dangerously-bypass-approvals-and-sandbox --model saved'
    })
  })
  // Paired-server agents belong to the workspace owner; the client list cannot detect them (#21429).
  it('detects agents on the paired server that owns the workspace', async () => {
    mocks.ensureDetectedAgents.mockResolvedValue([])
    resetStore(settingsWithGlobalRecipe(), [repoWithSavedRecipe('', null, 'runtime:env-1')])
    useAppStore.setState({
      worktreesByRepo: { 'repo-1': [makeWorktree({ id: 'repo-1::wt-1', repoId: 'repo-1' })] }
    })

    renderControlledDialog({ repoId: 'repo-1', worktreeId: 'repo-1::wt-1', connectionId: null })

    await vi.waitFor(() => expect(mocks.onStart).toHaveBeenCalledTimes(1), { timeout: 6_000 })
    expect(mocks.ensureRuntimeDetectedAgents).toHaveBeenCalledWith('env-1', 'repo-1::wt-1')
    expect(mocks.ensureDetectedAgents).not.toHaveBeenCalled()
  })
  it('reveals, and never auto-starts, a saved action whose runtime is replaced mid-discovery', async () => {
    resetStore(settingsWithGlobalRecipe(), [repoWithSavedRecipe('', null, 'runtime:env-1')])
    const worktree = makeWorktree({ id: 'repo-1::wt-1', repoId: 'repo-1' })
    useAppStore.setState({ worktreesByRepo: { 'repo-1': [worktree] } })
    renderControlledDialog({ repoId: 'repo-1', worktreeId: worktree.id, connectionId: null })
    for (const runtimeId of ['r1', 'r2']) {
      await flushEffects()
      expect(container.textContent).not.toContain('Launch agent')
      const statuses = new Map([['env-1', runtimeStatusEntry(runtimeId, false)]])
      act(() => useAppStore.setState({ runtimeStatusByEnvironmentId: statuses }))
    }
    await vi.waitFor(() => expect(container.textContent).toContain('Launch agent'))
    await flushEffects()
    expect(mocks.onStart).not.toHaveBeenCalled()
  })
  it('omits saved arguments from a structured local launch', async () => {
    setLocalRuntimeCapabilitiesForTests([STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY])
    const recipe = {
      agentId: 'codex' as const,
      commandInputTemplate: '{basePrompt}',
      agentArgs: '--model saved'
    }
    resetStore(
      {
        ...settingsWithGlobalRecipe(recipe),
        experimentalNativeChat: true
      },
      []
    )

    renderControlledDialog({ savedAgentArgs: recipe.agentArgs })

    await vi.waitFor(() => expect(mocks.onStart).toHaveBeenCalledTimes(1))
    expect(mocks.onStart).toHaveBeenCalledWith({
      agent: 'codex',
      commandInput: 'Resolve conflicts.',
      agentArgs: undefined
    })
  })
  it('renders the form and does not auto-start when the saved launch recipe mismatches', async () => {
    resetStore(
      settingsWithGlobalRecipe({ agentId: 'claude', commandInputTemplate: '{basePrompt}' })
    )
    renderControlledDialog()
    await vi.waitFor(() => expect(mocks.ensureDetectedAgents).toHaveBeenCalledTimes(1))
    await flushEffects()
    expect(mocks.onStart).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Launch agent')
    expect(container.textContent).toContain('Save & start agent')
  })
  it('reveals the form with status copy when the saved agent is unavailable', async () => {
    mocks.ensureDetectedAgents.mockResolvedValue([])
    resetStore(settingsWithGlobalRecipe())
    renderControlledDialog()
    expect(container.textContent).not.toContain('Launch agent')
    await vi.waitFor(() =>
      expect(container.textContent?.toLowerCase()).toContain('not enabled or was not detected')
    )
    expect(mocks.onStart).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Launch agent')
  })
  it('reveals the dialog and remains open when auto-start fails', async () => {
    mocks.onStart.mockResolvedValue(false)
    renderControlledDialog()
    expect(container.textContent).not.toContain('Launch agent')
    await vi.waitFor(() => expect(mocks.onStart).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(container.textContent).toContain('Launch agent'))
    expect(mocks.onLaunched).not.toHaveBeenCalled()
    expect(mocks.onOpenChange).not.toHaveBeenCalledWith(false)
    expect(mocks.toastError).toHaveBeenCalledTimes(1)
  })

  it('keeps prompt editing available when async auto-start delivery fails', async () => {
    mocks.onStart.mockImplementation(async () => {
      await Promise.resolve()
      return false
    })
    renderControlledDialog({
      baseCommandInput: 'Resolve queued comments.',
      savedCommandInputTemplate: '{basePrompt}'
    })
    expect(container.textContent).not.toContain('Launch agent')
    await vi.waitFor(() => expect(mocks.onStart).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(container.textContent).toContain('Launch agent'))

    expect(container.querySelector('textarea')?.value).toContain('{basePrompt}')
    expect(container.textContent).toContain('Start agent')
    expect(mocks.onLaunched).not.toHaveBeenCalled()
    expect(mocks.onOpenChange).not.toHaveBeenCalledWith(false)
  })

  it('does not auto-start when a saved receipt appears after the dialog is already open', async () => {
    let setSavedAgentId: (agent: TuiAgent | null) => void = () => {}

    function Harness(): React.JSX.Element {
      const [savedAgentId, setNextSavedAgentId] = useState<TuiAgent | null>(null)
      setSavedAgentId = setNextSavedAgentId
      return (
        <SourceControlAgentActionDialog
          open
          onOpenChange={mocks.onOpenChange}
          actionId="resolveConflicts"
          title="Launch agent"
          description="Review the launch recipe before starting."
          baseCommandInput="Resolve conflicts."
          savedCommandInputTemplate="{basePrompt}"
          savedAgentArgs=""
          launchSource="source_control_recovery"
          savedAgentId={savedAgentId}
          onSaveAgentDefault={mocks.onSaveAgentDefault}
          onLaunched={mocks.onLaunched}
          onStart={mocks.onStart}
        />
      )
    }
    act(() => {
      root.render(<Harness />)
    })
    await vi.waitFor(() => expect(container.textContent).toContain('Launch agent'))
    act(() => {
      setSavedAgentId('codex')
    })
    await flushEffects()
    expect(mocks.onStart).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Launch agent')
  })
  it('does not double-start during StrictMode effect replay', async () => {
    renderControlledDialog({}, { strictMode: true })

    await vi.waitFor(() => expect(mocks.onStart).toHaveBeenCalledTimes(1))
    await flushEffects()
    expect(mocks.onStart).toHaveBeenCalledTimes(1)
    expect(mocks.onLaunched).toHaveBeenCalledTimes(1)
  })

  it.each(['detection', 'recovery'] as const)(
    'cancels a manual launch during %s',
    async (stage) => {
      resetStore(settingsWithGlobalRecipe(null))
      renderControlledDialog()
      await vi.waitFor(() => expect(container.textContent).toContain('Save & start agent'))
      await flushEffects()
      const detection = deferred<TuiAgent[]>()
      const check = deferred<{ inFlight: boolean }>()
      if (stage === 'detection') {
        mocks.ensureDetectedAgents.mockReturnValueOnce(detection.promise)
      } else {
        mocks.mutationInFlight.mockReturnValueOnce(check.promise)
      }
      const start = Array.from(container.querySelectorAll('button')).find((entry) =>
        entry.textContent?.includes('Save & start agent')
      )
      if (!start) {
        throw new Error('Missing start button')
      }
      await act(async () => start.click())
      expect(
        stage === 'detection' ? mocks.ensureDetectedAgents : mocks.mutationInFlight
      ).toHaveBeenCalled()
      const cancel = Array.from(container.querySelectorAll('button')).find(
        (entry) => entry.textContent === 'Cancel'
      )
      if (!cancel) {
        throw new Error('Missing cancel button')
      }
      act(() => cancel.click())
      expect(mocks.onOpenChange).toHaveBeenCalledWith(false)
      await act(async () => {
        detection.resolve(['codex'])
        check.resolve({ inFlight: false })
      })
      await flushEffects()
      expect(mocks.onStart).not.toHaveBeenCalled()
      expect(mocks.onLaunched).not.toHaveBeenCalled()
      expect(mocks.onSaveAgentDefault).not.toHaveBeenCalled()
    }
  )

  it('cancels saved-recipe recovery when the dialog unmounts during its host check', async () => {
    const check = deferred<{ inFlight: boolean }>()
    mocks.mutationInFlight.mockReturnValueOnce(check.promise)
    renderControlledDialog()
    await flushEffects()
    expect(mocks.mutationInFlight).toHaveBeenCalledOnce()
    act(() => root.render(null))
    await act(async () => check.resolve({ inFlight: false }))
    await flushEffects()
    expect(mocks.onStart).not.toHaveBeenCalled()
    expect(mocks.onLaunched).not.toHaveBeenCalled()
  })

  it('blocks saved-recipe auto-start when Git starts during agent detection', async () => {
    const detection = deferred<TuiAgent[]>()
    mocks.ensureDetectedAgents.mockReturnValue(detection.promise)
    renderControlledDialog()
    mocks.mutationInFlight.mockResolvedValue({ inFlight: true })
    await act(async () =>
      detection.resolve(land({ localDetectedAgentIdsByContext: { host: ['codex'] } }))
    )

    await vi.waitFor(() => expect(container.textContent).toContain('Launch agent'))
    expect(mocks.onStart).not.toHaveBeenCalled()
    expect(mocks.onLaunched).not.toHaveBeenCalled()
    expect(mocks.onOpenChange).not.toHaveBeenCalledWith(false)
    expect(mocks.toastError).toHaveBeenCalledWith('Wait for the running Git operation to finish.')
  })

  it('blocks manual start if Git starts during the repeated agent check', async () => {
    resetStore(settingsWithGlobalRecipe(null))
    renderControlledDialog()
    await vi.waitFor(() => expect(container.textContent).toContain('Save & start agent'))
    await flushEffects()
    const detection = deferred<TuiAgent[]>()
    mocks.ensureDetectedAgents.mockReturnValue(detection.promise)
    const button = Array.from(container.querySelectorAll('button')).find((entry) =>
      entry.textContent?.includes('Save & start agent')
    )
    if (!button) {
      throw new Error('Missing start button')
    }
    act(() => button.click())
    expect(mocks.ensureDetectedAgents).toHaveBeenCalledTimes(2)
    mocks.mutationInFlight.mockResolvedValue({ inFlight: true })
    await act(async () => detection.resolve(['codex']))
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
