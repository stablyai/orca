// @vitest-environment happy-dom
import type * as StructuredAgentClient from '@/runtime/structured-agent-session-client'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import { clearHostAgentMenuSettingsForTests } from '../settings/use-host-agent-launch-preferences'
import { canonicalSourceControlActionSelection } from '../../../../shared/source-control-action-selection'
import { planAgentSessionLaunch } from '@/lib/agent-session-launch-plan'
import { useSavedSourceControlActionStart } from './use-saved-source-control-action-start'
import { mountSourceDialog } from './source-control-action-dialog.test-fixture'

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
