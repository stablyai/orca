// @vitest-environment happy-dom
import { mocks, hostMocks } from './launch-work-item-direct-test-fixture'
import { getDefaultSettings } from '../../../../../../shared/constants'
import { i18n } from '@/i18n/i18n'
import fr from '@/i18n/locales/fr.json'
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { sourceControlActionRecipeEntry } from '../../../../../../shared/source-control/ai/recipes/source-control-action-selection'
import { useAppStore } from '@/store/index'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import * as preparation from './launch-work-item-direct-route-preparation'
import * as preflight from './launch-work-item-direct-preflight'
import { adoptAgentSessionLaunchVerdict } from '../../../agent-session/launch/routing/agent-session-launch-plan'
import { newAgentLaunchRequestId } from '../../../agent-session/launch/routing/agent-launch-request-id'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../../shared/execution-host'
import { createUIStore } from '@/store/slices/ui/ui-slice-test-harness'
import { readDirectSetupRequest } from './direct-work-item-setup-test-fixture'
import { DirectWorkItemSetupDialog } from '@/components/new-workspace/DirectWorkItemSetupDialog'

import { projectRelationsTableFixture } from '../../../../../../shared/github/project-relations.test-fixture'
import {
  publicRuntimeEnvironment,
  connectedRuntimeStatus
} from '@/runtime/rpc/testing/paired-runtime-environment-test-fixture'
import { runtimeEnvironmentStatusFromSnapshot } from '../../../../../../shared/remote-runtime/host-status/runtime-host-status'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/rpc/environment-revisions/runtime-environment-revision'
import {
  resource,
  clearHostAgentMenuSettingsForTests
} from '@/runtime/agent-launch-settings/host-agent-launch-preferences-resource'
import { readAgentLaunchPreferencesForWorkspace } from '@/runtime/agent-launch-settings/use-host-agent-launch-preferences'
import { getRuntimeAgentInventoryKey } from '@/store/slices/agent-inventory/runtime-agent-inventory-key'

vi.mock('@/lib/repo-slug-index', () => ({
  useRepoSlugIndex: () => ({
    ready: true,
    lookupSlug: () => useAppStore.getState().repos[0],
    lookupSlugMatches: () => ({ origin: useAppStore.getState().repos, upstream: [] })
  })
}))

vi.doUnmock('@/lib/ensure-hooks-confirmed')
const { useSourceControlAgentActionStart } =
  await import('@/components/right-sidebar/source-control/ai/useSourceControlAgentActionStart')
const { startFixChecksFromDialog } =
  await import('@/components/pull-request-page/checks/fix-launch')
const { launchWorkItemDirect } = await import('./launch-work-item-direct')
const { useProjectRowActions } = await import('@/components/github-project/useProjectRowActions')
const { __resetTrustPromptChainForTests } = await import('../../../ensure-hooks-confirmed')

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

it.each([false, true])(
  'settles a real Ask Run trust digest rejection with precreate cancellation=%s',
  async (cancel) => {
    const ui = createUIStore()
    useAppStore.setState({
      openModal: ui.getState().openModal,
      closeModal: ui.getState().closeModal,
      modalData: {},
      repos: [
        {
          ...useAppStore.getState().repos[0],
          hookSettings: {
            mode: 'auto',
            scripts: { setup: '', archive: '' },
            setupRunPolicy: 'ask'
          }
        }
      ]
    })
    const unsubscribe = ui.subscribe(({ activeModal, modalData }) =>
      useAppStore.setState({ activeModal, modalData })
    )
    const digest = Promise.withResolvers<ArrayBuffer>()
    const hash = vi.spyOn(crypto.subtle, 'digest').mockReturnValueOnce(digest.promise)
    hostMocks.checkRuntimeHooks.mockResolvedValue({
      hasHooks: true,
      hooks: { scripts: { setup: 'echo setup' } }
    })
    const view = mountStart()
    let start: Promise<boolean>
    try {
      act(() => {
        start = view.result.current.startWithDetectedAgents({ detectedAgents: ['codex'] })
      })
      await vi.waitFor(() =>
        expect(useAppStore.getState().activeModal).toBe('new-workspace-composer')
      )
      render(
        <DirectWorkItemSetupDialog
          request={readDirectSetupRequest(useAppStore.getState().modalData.directSetup)}
        />
      )
      fireEvent.click(screen.getByRole('button', { name: 'Run setup' }))
      await vi.waitFor(() => expect(hash).toHaveBeenCalledOnce())
      if (cancel) {
        act(() => view.result.current.cancelStart())
      }
      await act(async () => {
        digest.reject(new DOMException('Setup trust hash failed', 'OperationError'))
        expect(await start!).toBe(false)
      })
      expect(mocks.toastError.mock.calls).toEqual(
        cancel
          ? []
          : [['Could not start a new Codex session.', { description: 'Setup trust hash failed' }]]
      )
      expect(mocks.createWorktree).not.toHaveBeenCalled()
      expect(view.onLaunched).not.toHaveBeenCalled()
      expect(view.onClose).not.toHaveBeenCalled()
      expect(view.result.current.isStarting).toBe(false)
    } finally {
      unsubscribe()
    }
  }
)

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
    await vi.waitFor(() => {
      expect(mocks.createWorktree).toHaveBeenCalledOnce()
      expect(view.result.current.isCreateAccepted).toBe(true)
    })
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

it.each(['settled-host', 'pending-host', 'missing-owner', 'pr-head', 'arguments'] as const)(
  'Fix checks reports one precreate failure, with pending silent: %s',
  async (failure) => {
    if (failure === 'settled-host' || failure === 'pending-host') {
      useAppStore.setState({
        repos: [{ ...useAppStore.getState().repos[0], connectionId: 'ssh-1' }],
        sshConnectionStates: new Map([
          [
            'ssh-1',
            {
              targetId: 'ssh-1',
              status: failure === 'pending-host' ? 'connecting' : 'connected',
              error: null,
              reconnectAttempt: 0
            }
          ]
        ])
      })
    } else if (failure === 'missing-owner') {
      useAppStore.setState({ repos: [] })
    } else if (failure === 'pr-head') {
      mocks.resolvePrBase.mockResolvedValueOnce({
        error: 'PR #42 not found.',
        errorCode: 'github.prNotFound',
        errorParams: { number: 42 }
      })
    }
    const view = mountStart(failure === 'arguments' ? "--model '" : undefined)
    await act(async () => {
      expect(await view.result.current.startWithDetectedAgents({ detectedAgents: ['codex'] })).toBe(
        false
      )
    })
    expect(mocks.toastError).toHaveBeenCalledTimes(
      failure === 'pending-host' || failure === 'arguments' ? 0 : 1
    )
    if (failure !== 'pending-host' && failure !== 'arguments') {
      expect(mocks.toastError.mock.calls[0][0]).toBe('Could not start a new Codex session.')
    }
    if (failure === 'settled-host') {
      expect(mocks.toastError.mock.calls[0][1]).toEqual({
        description:
          'Terminal launch is unavailable on this SSH host. Open a terminal in the workspace and start the agent there.'
      })
    }
    expect(mocks.createWorktree).not.toHaveBeenCalled()
    expect(view.onLaunched).not.toHaveBeenCalled()
    expect(view.onClose).not.toHaveBeenCalled()
    expect(view.result.current.isStarting).toBe(false)
  }
)

it('keeps a functional navigation fallback after reporting a PR lookup failure', async () => {
  mocks.resolvePrBase.mockResolvedValueOnce({
    error: 'PR #42 not found.',
    errorCode: 'github.prNotFound',
    errorParams: { number: 42 }
  })
  const fallback = vi.fn()
  const notified = vi.fn()
  expect(
    await launchWorkItemDirect({
      item,
      repoId: 'repo-1',
      agentOverride: 'codex',
      launchSource: 'task_page',
      openModalFallback: fallback,
      onFailureNotified: notified
    })
  ).toBe(false)
  expect(fallback).toHaveBeenCalledOnce()
  expect(notified).toHaveBeenCalledOnce()
  expect(mocks.toastError).toHaveBeenCalledOnce()
  expect(mocks.createWorktree).not.toHaveBeenCalled()
})

it('Fix checks localizes the one named-agent PR lookup failure', async () => {
  const language = i18n.language
  i18n.addResourceBundle('fr', 'translation', fr)
  try {
    await i18n.changeLanguage('fr')
    mocks.resolvePrBase.mockResolvedValueOnce({
      error: 'PR #42 not found.',
      errorCode: 'github.prNotFound',
      errorParams: { number: 42 }
    })
    const view = mountStart()
    await act(async () => {
      expect(await view.result.current.startWithDetectedAgents({ detectedAgents: ['codex'] })).toBe(
        false
      )
    })
    expect(mocks.toastError).toHaveBeenCalledExactlyOnceWith(
      'Impossible de démarrer une nouvelle session Codex.',
      {
        description:
          'Impossible de lire la pull request. Vérifiez que vous pouvez l’ouvrir, puis réessayez.'
      }
    )
    expect(mocks.createWorktree).not.toHaveBeenCalled()
  } finally {
    await i18n.changeLanguage(language)
  }
})

it('Start work reports one truthful recovery before a remote agent has been selected', async () => {
  const environment = publicRuntimeEnvironment({
    id: 'hub-a',
    pairingRevision: 1,
    runtimeId: 'hub-runtime'
  })
  replaceRuntimeEnvironmentRevisions([environment])
  try {
    const state = useAppStore.getState()
    useAppStore.setState({
      repos: [{ ...state.repos[0], path: '/srv/repo', executionHostId: 'runtime:hub-a' }],
      settings: { ...getDefaultSettings('/tmp'), defaultTuiAgent: 'claude' },
      runtimeEnvironments: [environment],
      runtimeDetectedAgentIds: { [getRuntimeAgentInventoryKey('hub-a')]: ['codex'] },
      runtimeStatusByEnvironmentId: new Map([
        [
          'hub-a',
          runtimeEnvironmentStatusFromSnapshot({
            environmentId: 'hub-a',
            pairingRevision: 1,
            sequence: 1,
            checkedAt: 1,
            status: connectedRuntimeStatus('hub-runtime', 1).status,
            verification: 'verified',
            transport: 'ready'
          })
        ]
      ])
    })
    const preferences = resource({
      environmentId: 'hub-a',
      pairingRevision: 1,
      runtimeId: 'hub-runtime'
    })
    preferences.snapshot = { defaultTuiAgent: 'codex', disabledTuiAgents: [] }
    expect(
      readAgentLaunchPreferencesForWorkspace(useAppStore.getState(), {
        kind: 'git-worktree',
        repoId: 'repo-1',
        executionHostId: 'runtime:hub-a'
      }).defaultTuiAgent
    ).toBe('codex')
    const table = projectRelationsTableFixture()
    const row = table.rows[0]
    row.content.url = 'https://github.com/acme/repo/issues/1'
    const view = renderHook(() =>
      useProjectRowActions({
        table,
        currentCacheKey: 'project-key',
        selectedRepoIds: new Set(['repo-1'])
      })
    )
    await act(async () => view.result.current.startWork(row))
    expect(mocks.toastError).toHaveBeenCalledExactlyOnceWith(
      'Update Orca on this workspace’s server, then try again.'
    )
    expect(mocks.createWorktree).not.toHaveBeenCalled()
    expect(hostMocks.callRuntimeRpc).not.toHaveBeenCalled()
    expect(mocks.ensureDetectedAgents).not.toHaveBeenCalled()
    expect(mocks.ensureRemoteDetectedAgents).not.toHaveBeenCalled()
  } finally {
    clearHostAgentMenuSettingsForTests()
    replaceRuntimeEnvironmentRevisions([])
  }
})
