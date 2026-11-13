// @vitest-environment happy-dom
import { mocks } from './launch-work-item-direct-test-fixture'

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { sourceControlActionRecipeEntry } from '../../../../../../shared/source-control/ai/recipes/source-control-action-selection'
import { useAppStore } from '@/store/index'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'

import * as preflight from './launch-work-item-direct-preflight'

vi.doUnmock('@/runtime/repo-hooks/ensure-hooks-confirmed')
const { useSourceControlAgentActionStart } =
  await import('@/components/right-sidebar/source-control/ai/useSourceControlAgentActionStart')
const { startFixChecksFromDialog } =
  await import('@/components/pull-request-page/checks/fix-launch')
await import('./launch-work-item-direct')

const { __resetTrustPromptChainForTests } =
  await import('../../../../runtime/repo-hooks/ensure-hooks-confirmed')

const structured = vi.hoisted(() => vi.fn())
vi.mock('@/lib/agent-session/structured-agent-session-provisional-tab', () => ({
  beginStructuredAgentSessionProvisionalLaunch: structured
}))

afterEach(cleanup)
beforeEach(() => {
  __resetTrustPromptChainForTests()
  useAppStore.setState({ trustedOrcaHooks: {} })
})
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
function mountStart(agentArgs = '--model o3') {
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
        recipe: sourceControlActionRecipeEntry({ agentId: 'codex', agentArgs }),
        saveLaunchRecipe: false,
        saveTargetValue: 'none',
        actionId: 'fixChecks',
        repoId: 'repo-1',
        agentLaunchPreferences: {
          defaultTuiAgent: 'codex',
          disabledTuiAgents: [],
          agentLaunchChoices: {}
        },
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
