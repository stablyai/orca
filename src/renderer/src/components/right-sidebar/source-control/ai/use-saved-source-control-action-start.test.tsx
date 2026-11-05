// @vitest-environment happy-dom
import type * as StructuredAgentClient from '@/runtime/structured-agent-session-client'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import { clearHostAgentMenuSettingsForTests } from '../../../../runtime/agent-launch-settings/host-agent-launch-preferences-resource'
import { canonicalSourceControlActionSelection } from '../../../../../../shared/source-control/ai/recipes/source-control-action-selection'
import { planAgentSessionLaunch } from '@/lib/agent-session-launch-plan'
import { useSavedSourceControlActionStart } from './use-saved-source-control-action-start'
import { mountSourceDialog, renderDialog } from '../panel/source-control-action-dialog.test-fixture'

vi.mock('@/runtime/structured-agent-session-client', async (importOriginal) => ({
  ...(await importOriginal<typeof StructuredAgentClient>()),
  callStructuredAgentSession: vi.fn(async () => undefined)
}))

const initial = useAppStore.getState()
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  clearHostAgentMenuSettingsForTests()
  useAppStore.setState(initial, true)
  setLocalRuntimeCapabilitiesForTests(null)
})

it('saved primary Chat skips Terminal-only validation under CLI settings and dispatches the captured two views', async () => {
  const recipe = {
    agentId: 'codex' as const,
    surface: 'chat' as const,
    agentArgs: '--model "unterminated'
  }
  const f = mountSourceDialog(recipe, recipe)
  act(() =>
    useAppStore.setState(({ settings }) => ({
      settings: { ...settings!, nativeChatProviders: { codex: false } },
      worktreesByRepo: { [f.repo.id]: [makeWorktree({ id: 'wt-saved', repoId: f.repo.id })] },
      ensureDetectedAgents: async () => ['codex']
    }))
  )
  f.onStart.mockImplementation(async (launch) => {
    const plan = planAgentSessionLaunch(useAppStore.getState(), {
      requestId: 'saved-primary',
      agent: launch.agent,
      workspace: { kind: 'git-worktree', worktreeId: 'wt-saved' },
      preferredSurface: launch.preferredSurface,
      requestedSurface: launch.launchChoice?.requestedSurface,
      launchOptions: launch.sessionOptions,
      chatLaunchOptions: launch.chatSessionOptions
    })
    expect(plan.route).toBe('structured-native-chat')
    expect(plan).not.toHaveProperty('requestedSurface')
    expect(launch.agentArgs).toBe('--model "unterminated')
    expect(launch.preferredSurface).toBe('chat')
    return true
  })
  const fallback = vi.fn()
  const primary = renderHook(useSavedSourceControlActionStart)
  await act(async () =>
    primary.result.current.start({
      selection: canonicalSourceControlActionSelection(recipe),
      basePrompt: 'fix',
      actionId: 'resolveConflicts',
      repoId: f.repo.id,
      repo: f.repo,
      settings: useAppStore.getState().settings,
      worktreeId: 'wt-saved',
      connectionId: null,
      promptDelivery: 'submit-after-ready',
      launchPlatform: 'darwin',
      launchSource: 'source_control_recovery',
      onStart: f.onStart,
      onClose: vi.fn(),
      onFallback: fallback
    })
  )
  expect(f.onStart).toHaveBeenCalledOnce()
  expect(fallback).not.toHaveBeenCalled()
  expect(f.persist).not.toHaveBeenCalled()
  primary.unmount()
})

it('preserves a stored equal surface on single-mode acceptance while keeping the live explicit operation', async () => {
  const recipe = { agentId: 'codex' as const, surface: 'terminal' as const, agentArgs: '--search' }
  const f = renderDialog(false, true, recipe)
  await waitFor(() => expect(f.result.current.canStart).toBe(true))
  act(() => f.result.current.onAgentPick('codex', 'terminal'))
  expect(f.result.current.recipe).toMatchObject(recipe)
  expect(f.result.current.surfaceRows.selection.choice).toMatchObject({
    route: 'terminal-tui',
    requestedSurface: 'terminal'
  })
  expect(f.result.current.agentArgsApply).toBe(true)
})

it.each(
  (['claude', 'codex'] as const).flatMap((agent) =>
    (['chat', 'terminal'] as const).map((surface) => ({ agent, surface }))
  )
)(
  'dispatches the exact newly authored $agent $surface recipe through saved start against opposite Settings',
  async ({ agent, surface }) => {
    const recipe = {
      agentId: agent,
      surface,
      agentArgs: '--add-dir "two words"',
      commandInputTemplate: 'current {basePrompt}',
      launchPreferences: {
        agentId: agent,
        modelSelection: {
          base: 'default' as const,
          model: { agentId: agent, value: agent === 'claude' ? 'sonnet' : 'gpt-5.5' },
          options: { effort: { agentId: agent, value: 'high' } }
        },
        permissionMode: 'own' as const
      }
    }
    const original = structuredClone(recipe)
    const f = mountSourceDialog(recipe, recipe)
    act(() =>
      useAppStore.setState(({ settings }) => ({
        settings: { ...settings!, nativeChatProviders: { [agent]: surface !== 'chat' } },
        worktreesByRepo: { [f.repo.id]: [makeWorktree({ id: 'wt-writer', repoId: f.repo.id })] },
        ensureDetectedAgents: async () => [agent]
      }))
    )
    f.onStart.mockImplementation(async (launch) => {
      expect(launch.agent).toBe(agent)
      expect(launch.commandInput).toBe('current fix')
      expect(launch.agentArgs).toBe('--add-dir "two words"')
      expect(launch.sessionOptions).toEqual({
        model: agent === 'claude' ? 'sonnet' : 'gpt-5.5',
        effort: 'high',
        permissionMode: 'own'
      })
      expect(launch.chatSessionOptions).toBeUndefined()
      expect(launch.preferredSurface).toBe(surface === 'chat' ? 'chat' : undefined)
      expect(launch.launchChoice?.requestedSurface).toBe(
        surface === 'terminal' ? 'terminal' : undefined
      )
      expect(launch.launchChoice?.route).toBe(
        surface === 'chat' ? 'structured-native-chat' : 'terminal-tui'
      )
      const plan = planAgentSessionLaunch(useAppStore.getState(), {
        requestId: 'saved-writer',
        agent: launch.agent,
        workspace: { kind: 'git-worktree', worktreeId: 'wt-writer' },
        prompt: launch.commandInput,
        preferredSurface: launch.preferredSurface,
        requestedSurface: launch.launchChoice?.requestedSurface,
        launchOptions: launch.sessionOptions,
        chatLaunchOptions: launch.chatSessionOptions
      })
      expect(plan.route).toBe(surface === 'chat' ? 'structured-native-chat' : 'terminal-tui')
      expect(plan.prompt).toBe('current fix')
      expect(plan.launchOptions).toEqual({
        model: agent === 'claude' ? 'sonnet' : 'gpt-5.5',
        effort: 'high',
        permissionMode: 'own'
      })
      if (surface === 'chat') {
        expect(plan).not.toHaveProperty('requestedSurface')
      } else {
        expect(plan.requestedSurface).toBe('terminal')
      }
      return true
    })
    const fallback = vi.fn()
    const close = vi.fn()
    const primary = renderHook(useSavedSourceControlActionStart)
    await act(async () =>
      primary.result.current.start({
        selection: canonicalSourceControlActionSelection(recipe),
        basePrompt: 'fix',
        actionId: 'fixChecks',
        repoId: f.repo.id,
        repo: f.repo,
        settings: useAppStore.getState().settings,
        worktreeId: 'wt-writer',
        connectionId: null,
        promptDelivery: 'submit-after-ready',
        launchPlatform: 'darwin',
        launchSource: 'source_control_recovery',
        onStart: f.onStart,
        onClose: close,
        onFallback: fallback
      })
    )
    expect(f.onStart).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
    expect(fallback).not.toHaveBeenCalled()
    expect(f.persist).not.toHaveBeenCalled()
    expect(primary.result.current.isStarting).toBe(false)
    expect(recipe).toEqual(original)
    primary.unmount()
  }
)
