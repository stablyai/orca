// @vitest-environment happy-dom
import { mocks, hostMocks } from './launch-work-item-direct-test-fixture'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useSourceControlAgentActionStart } from '@/components/right-sidebar/useSourceControlAgentActionStart'
import { startFixChecksFromDialog } from '@/components/pull-request-page/checks/fix-launch'
import { sourceControlActionRecipeEntry } from '../../../shared/source-control-action-selection'
import { useAppStore } from '@/store'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import * as preparation from './launch-work-item-direct-route-preparation'
import * as preflight from './launch-work-item-direct-preflight'
import { adoptAgentSessionLaunchVerdict } from './agent-session-launch-plan'
import { newAgentLaunchRequestId } from './agent-launch-request-id'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'

const structured = vi.hoisted(() => vi.fn())
vi.mock('@/lib/agent-session/structured-agent-session-provisional-tab', () => ({
  beginStructuredAgentSessionProvisionalLaunch: structured
}))

afterEach(cleanup)
const item = {
  id: 'pr-42',
  state: 'open',
  labels: [],
  updatedAt: '',
  author: null,
  repoId: 'repo-1',
  type: 'pr',
  number: 42,
  title: 'Fix checks',
  url: 'https://github.com/acme/repo/pull/42'
} as const
const created = {
  worktree: makeWorktree({
    id: 'repo-1::/repo/worktree',
    path: '/repo/worktree',
    repoId: 'repo-1'
  }),
  setup: { command: 'echo setup', cwd: '/repo/worktree' },
  defaultTabs: [{ type: 'terminal', title: 'Shell' }]
}
function mountStart() {
  const onClose = vi.fn()
  const onLaunched = vi.fn()
  const initialProps: { open: boolean; connectionId: string | null } = {
    open: true,
    connectionId: null
  }
  const view = renderHook(
    ({ open, connectionId }) =>
      useSourceControlAgentActionStart({
        open,
        connectionId,
        selectedAgent: 'codex',
        commandInput: 'Edited prompt',
        trimmedCommandInput: 'Edited prompt',
        agentArgsApply: true,
        recipe: sourceControlActionRecipeEntry({ agentId: 'codex', agentArgs: '--model o3' }),
        saveLaunchRecipe: false,
        saveTargetValue: 'none',
        actionId: 'fixChecks',
        repoId: 'repo-1',
        agentLaunchPreferences: {
          defaultTuiAgent: 'codex',
          disabledTuiAgents: [],
          agentLaunchChoices: {}
        },
        settings: null,
        repo: null,
        promptDelivery: 'submit-after-ready',
        launchPlatform: 'linux',
        launchSource: 'task_page',
        connectionUnavailable: false,
        detectedAgents: ['codex'],
        onStart: (launch) =>
          startFixChecksFromDialog({
            ...launch,
            item: { ...item, labels: [] },
            targetRepoId: 'repo-1'
          }),
        onLaunched,
        onClose
      }),
    { initialProps }
  )
  return { ...view, onClose, onLaunched }
}

it.each(['terminal', 'structured'] as const)(
  'retains an issued %s create through hide/cleanup and matching settlement',
  async (route) => {
    const pending = Promise.withResolvers<typeof created>()
    mocks.createWorktree.mockReturnValueOnce(pending.promise)
    hostMocks.checkRuntimeHooks.mockResolvedValue({ hasHooks: false, hooks: null })
    if (route === 'structured') {
      const plan = adoptAgentSessionLaunchVerdict({
        requestId: newAgentLaunchRequestId(),
        route: 'structured-native-chat',
        agent: 'codex',
        executionHostId: LOCAL_EXECUTION_HOST_ID,
        worktreeId: created.worktree.id,
        prompt: 'Edited prompt',
        promptDelivery: 'submit-after-ready',
        launchOptions: { model: 'o3' },
        requestedSurface: 'chat'
      })
      vi.spyOn(preflight, 'planDirectWorkItemLaunch').mockResolvedValueOnce(plan)
      structured.mockImplementationOnce(({ plan: submitted, beforeOpen }) => {
        expect(submitted).toMatchObject({ prompt: 'Edited prompt', launchOptions: { model: 'o3' } })
        expect(beforeOpen()).toBe(true)
        return { tab: { id: 'chat-tab' } }
      })
    }
    const view = mountStart()
    let start: Promise<boolean>
    act(() => {
      start = view.result.current.startWithDetectedAgents({ detectedAgents: ['codex'] })
    })
    await vi.waitFor(() => expect(mocks.createWorktree).toHaveBeenCalledOnce())
    expect(view.result.current.isCreateAccepted).toBe(true)
    act(() => view.result.current.cancelStart())
    view.rerender({ open: false, connectionId: 'another-context' })
    view.rerender({ open: true, connectionId: 'another-context' })
    expect(view.result.current.isStarting).toBe(true)
    await act(async () =>
      expect(await view.result.current.startWithDetectedAgents({ detectedAgents: ['codex'] })).toBe(
        false
      )
    )
    await act(async () => {
      // The real store publishes a workspace before returning its create result.
      useAppStore.setState({
        worktreesByRepo: { 'repo-1': [{ ...created.worktree, repoId: 'repo-1' }] }
      })
      pending.resolve(created)
      expect(await start!).toBe(true)
    })
    expect(mocks.createWorktree).toHaveBeenCalledOnce()
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith(
      created.worktree.id,
      expect.objectContaining({ setup: created.setup, defaultTabs: created.defaultTabs })
    )
    if (route === 'terminal') {
      expect(mocks.pasteDraftWhenAgentReady).toHaveBeenCalledWith(
        expect.objectContaining({ content: 'Edited prompt', agent: 'codex', submit: true })
      )
    } else {
      expect(structured).toHaveBeenCalledOnce()
      expect(mocks.pasteDraftWhenAgentReady).not.toHaveBeenCalled()
    }
    expect(view.onLaunched).toHaveBeenCalledOnce()
    expect(view.onClose).not.toHaveBeenCalled()
    expect(view.result.current.isStarting).toBe(false)
    expect(mocks.toastError).not.toHaveBeenCalled()
  }
)

it.each(['create', 'agent-preparation', 'activation', 'prompt-plan'] as const)(
  'reports one real accepted %s failure after detachment and releases for retry',
  async (stage) => {
    const gate = Promise.withResolvers<never>()
    const creation = Promise.withResolvers<typeof created>()
    if (stage === 'create') {
      mocks.createWorktree.mockReturnValueOnce(gate.promise)
    } else if (stage === 'agent-preparation') {
      vi.spyOn(preparation, 'prepareDirectWorkItemAgentLaunch').mockReturnValueOnce(gate.promise)
    } else if (stage === 'activation') {
      mocks.createWorktree.mockReturnValueOnce(creation.promise)
      mocks.activateAndRevealWorktree.mockReturnValueOnce(false)
    } else {
      mocks.createWorktree.mockReturnValueOnce(creation.promise)
      const actualPrepare = preparation.prepareDirectWorkItemAgentLaunch
      vi.spyOn(preparation, 'prepareDirectWorkItemAgentLaunch').mockImplementationOnce(
        async (args) => ({ ...(await actualPrepare(args)), startupPlanFailed: true })
      )
    }
    const view = mountStart()
    let start: Promise<boolean>
    act(() => {
      start = view.result.current.startWithDetectedAgents({ detectedAgents: ['codex'] })
    })
    await vi.waitFor(() => expect(mocks.createWorktree).toHaveBeenCalledOnce())
    act(() => view.result.current.cancelStart())
    creation.resolve(created)
    if (stage === 'create' || stage === 'agent-preparation') {
      gate.reject(new Error('Accepted preparation failed'))
    }
    await act(async () => expect(await start!).toBe(false))
    expect(mocks.toastError).toHaveBeenCalledOnce()
    expect(view.onLaunched).not.toHaveBeenCalled()
    expect(view.onClose).not.toHaveBeenCalled()
    expect(view.result.current.isStarting).toBe(false)
    await act(async () =>
      expect(await view.result.current.startWithDetectedAgents({ detectedAgents: ['codex'] })).toBe(
        true
      )
    )
    expect(mocks.createWorktree).toHaveBeenCalledTimes(2)
  }
)

it('does not release or close a successor when cancelled pre-create work later settles', async () => {
  const oldPlan =
    Promise.withResolvers<Awaited<ReturnType<typeof preflight.planDirectWorkItemLaunch>>>()
  const plan = vi.spyOn(preflight, 'planDirectWorkItemLaunch').mockReturnValueOnce(oldPlan.promise)
  const creation = Promise.withResolvers<typeof created>()
  mocks.createWorktree.mockReturnValueOnce(creation.promise)
  const view = mountStart()
  let old: Promise<boolean>
  act(() => {
    old = view.result.current.startWithDetectedAgents({ detectedAgents: ['codex'] })
  })
  await vi.waitFor(() => expect(plan).toHaveBeenCalledOnce())
  act(() => view.result.current.cancelStart())
  let successor: Promise<boolean>
  act(() => {
    successor = view.result.current.startWithDetectedAgents({ detectedAgents: ['codex'] })
  })
  await vi.waitFor(() => expect(mocks.createWorktree).toHaveBeenCalledOnce())
  await act(async () => {
    oldPlan.resolve(undefined)
    expect(await old!).toBe(false)
  })
  expect(view.result.current.isStarting).toBe(true)
  expect(view.result.current.isCreateAccepted).toBe(true)
  expect(view.onClose).not.toHaveBeenCalled()
  await act(async () =>
    expect(await view.result.current.startWithDetectedAgents({ detectedAgents: ['codex'] })).toBe(
      false
    )
  )
  await act(async () => {
    creation.resolve(created)
    expect(await successor!).toBe(true)
  })
  expect(mocks.createWorktree).toHaveBeenCalledOnce()
  expect(view.onClose).toHaveBeenCalledOnce()
  expect(view.result.current.isStarting).toBe(false)
})
