// @vitest-environment happy-dom
import { EVERY_AGENT_CHAT } from '../../../../shared/native-chat/every-agent-chat.test-fixture'
import { act, cleanup, render, renderHook, screen } from '@testing-library/react'
import AgentCombobox from '@/components/agent/AgentCombobox'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AGENT_CATALOG } from '@/lib/agent-catalog'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { useAgentDetectionTargetForWorktree } from '@/hooks/useAgentDetectionTarget'
import { workspaceKindForWorktreeId } from '@/lib/agent-launch-route-input'
import {
  makeFolderWorkspace,
  makeWorktree,
  TEST_REPO
} from '@/store/slices/worktrees-slice-test-fixtures'
import { makeProjectGroup } from '@/components/sidebar/folder-workspace-composer-submit-fixtures'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import { getDefaultSettings } from '../../../../shared/constants'
import type { AppState } from '@/store/types'
import {
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY as CHAT,
  STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY as CLIENT
} from '../../../../shared/agent-session/agent-session-runtime-capabilities'
import { useAgentMenuObservation, useNewTabAgentMenuRows } from './use-new-tab-agent-menu-rows'
import { sourceControlRepoAgentRows } from '@/lib/source-control-agent-picker'
const initial = useAppStore.getState()
afterEach(() => {
  cleanup()
  useAppStore.setState(initial, true)
  setLocalRuntimeCapabilitiesForTests(null)
})
it('settles ownerless continuation and plus inventory without borrowing agents, then recovers on hydration', async () => {
  const group = makeProjectGroup()
  const folder = makeFolderWorkspace({ id: 'f1', projectGroupId: group.id, folderPath: '/work' })
  const repo = { ...TEST_REPO, id: 'r1', path: '/work/local' }
  const cases: { worktreeId: string; rows: Partial<AppState> }[] = [
    {
      worktreeId: 'folder:f1',
      rows: {
        folderWorkspaces: [
          { ...folder, executionHostId: 'local' },
          { ...folder, executionHostId: 'ssh:other' }
        ]
      }
    },
    {
      worktreeId: 'folder:f1',
      rows: {
        folderWorkspaces: [folder],
        projectGroups: [group],
        repos: [repo, { ...repo, id: 'r2', path: '/work/remote', connectionId: 'other' }]
      }
    },
    { worktreeId: 'r1::/remote/restored', rows: { repos: [repo] } }
  ]
  for (const { worktreeId, rows } of cases) {
    const local = vi.fn<AppState['ensureDetectedAgents']>(async () => ['claude'])
    const otherHost = vi.fn(async () => [])
    const getStatus = vi.fn()
    Object.assign(window, { api: { runtime: { getStatus } } })
    setLocalRuntimeCapabilitiesForTests(worktreeId.startsWith('folder:') ? null : [CHAT, CLIENT])
    useAppStore.setState({
      ...initial,
      settings: { ...getDefaultSettings('/home/me'), nativeChatProviders: EVERY_AGENT_CHAT },
      activeWorktreeId: worktreeId,
      activeWorkspaceExecutionHostId: null,
      folderWorkspaces: [],
      projectGroups: [],
      repos: [],
      worktreesByRepo: {},
      detectedWorktreesByRepo: {},
      restoredRuntimeHostIdByWorkspaceSessionKey: {},
      detectedAgentIds: ['gemini'],
      remoteDetectedAgentIds: { other: ['codex'] },
      ensureDetectedAgents: local,
      ensureRemoteDetectedAgents: otherHost,
      ensureRuntimeDetectedAgents: otherHost,
      ...rows
    })
    const hook = renderHook(() => {
      const target = useAgentDetectionTargetForWorktree(worktreeId)
      const workspace = { kind: workspaceKindForWorktreeId(worktreeId), worktreeId }
      return {
        form: useAgentMenuObservation({ workspace }, true, target),
        plus: useNewTabAgentMenuRows(worktreeId, true, target)
      }
    })
    expect(hook.result.current.form.detection).toMatchObject({ detectedIds: [], isLoading: false })
    expect(hook.result.current.form.selectionFor('claude', 'terminal').ready).toBe(false)
    for (const model of [hook.result.current.form.model, hook.result.current.plus]) {
      expect(model.state).toBe('settled')
      expect(
        model.state === 'settled' &&
          model.rows.every(
            (row) =>
              row.kind === 'chat-unavailable' &&
              row.reason === 'check-failed' &&
              row.executionHostId === undefined
          )
      ).toBe(true)
    }
    for (const probe of [local, otherHost, getStatus]) {
      expect(probe).not.toHaveBeenCalled()
    }
    local.mockImplementation(async () => {
      useAppStore.setState({ detectedAgentIds: ['claude'] })
      return ['claude']
    })
    await act(async () => {
      setLocalRuntimeCapabilitiesForTests([CHAT, CLIENT])
      useAppStore.setState({
        folderWorkspaces: [{ ...folder, executionHostId: 'local' }],
        repos: [repo],
        worktreesByRepo: {
          r1: [makeWorktree({ id: worktreeId, repoId: 'r1', hostId: 'local', path: '/work/local' })]
        },
        detectedAgentIds: null
      })
    })
    expect(hook.result.current.form.detection.detectedIds).toEqual(['claude'])
    expect(hook.result.current.form.selectionFor('claude').ready).toBe(true)
    expect(
      hook.result.current.plus.state === 'settled' && hook.result.current.plus.rows
    ).toContainEqual({ kind: 'chat', agent: 'claude', executionHostId: 'local' })
    hook.unmount()
  }
})

const worktreeId = 'r1::/remote'
const sshState = {
  targetId: 'box',
  status: 'connecting' as const,
  error: null,
  reconnectAttempt: 0
}
const repo = { ...TEST_REPO, id: 'r1', connectionId: 'box', executionHostId: 'ssh:box' }

/** An SSH workspace whose host has not reported its OS, with Codex's CLI already detected. */
function seedSshWorkspace(): void {
  setLocalRuntimeCapabilitiesForTests([])
  useAppStore.setState({
    ...initial,
    settings: { ...getDefaultSettings('/home/me'), agentDefaultSurface: 'terminal' },
    activeWorktreeId: worktreeId,
    repos: [repo],
    worktreesByRepo: {
      r1: [makeWorktree({ id: worktreeId, repoId: 'r1', hostId: 'ssh:box', path: '/remote' })]
    },
    remoteDetectedAgentIds: { box: ['codex'] },
    sshConnectionStates: new Map([['box', sshState]]),
    ensureRemoteDetectedAgents: vi.fn(async () => ['codex'])
  })
}

it('holds only terminal choices while SSH connects, for a workspace and a repo target, then settles', async () => {
  seedSshWorkspace()
  const hook = renderHook(() => {
    const target = useAgentDetectionTargetForWorktree(worktreeId)
    // Source Control's launch into a workspace the repo does not have yet.
    const prospective = sourceControlRepoAgentRows(repo)
    return {
      workspace: useAgentMenuObservation(worktreeId, true, target),
      repo: useAgentMenuObservation(prospective.target, true, prospective.detectionTarget)
    }
  })
  const pendingKey = hook.result.current.workspace.contextKey
  for (const observation of [hook.result.current.workspace, hook.result.current.repo]) {
    expect(observation.model).toMatchObject({ state: 'settled', terminalPending: true })
    expect(observation.selectionFor('codex', 'terminal').ready).toBe(false)
  }
  await act(async () => {
    useAppStore.setState({
      sshConnectionStates: new Map([['box', { ...sshState, status: 'connected' }]])
    })
  })
  // Readiness is not identity: the picker's owner and acquisition keep their key.
  expect(hook.result.current.workspace.contextKey).toBe(pendingKey)
  for (const observation of [hook.result.current.workspace, hook.result.current.repo]) {
    expect(observation.model).toMatchObject({ state: 'settled', terminalPending: false })
    // A settled missing fact is owned by the launcher; it must not leave a permanent wait.
    expect(observation.selectionFor('codex', 'terminal').ready).toBe(true)
  }
  await act(async () => {
    useAppStore.setState({
      sshConnectionStates: new Map([
        ['box', { ...sshState, status: 'connected', remotePlatform: 'linux' }]
      ])
    })
  })
  expect(hook.result.current.workspace.model).toMatchObject({
    state: 'settled',
    terminalPending: false,
    rows: expect.arrayContaining([
      expect.objectContaining({ agent: 'codex', executionHostId: 'ssh:box' })
    ])
  })
  expect(hook.result.current.workspace.selectionFor('codex', 'terminal').ready).toBe(true)
})

it('lets the picker open to choose chat while only the chosen terminal waits for SSH', () => {
  seedSshWorkspace()
  let ready: boolean | undefined
  function Picker() {
    const observation = useAgentMenuObservation(
      worktreeId,
      true,
      useAgentDetectionTargetForWorktree(worktreeId)
    )
    const selection = observation.selectionFor('codex', 'terminal')
    ready = selection.ready
    return (
      <AgentCombobox
        agents={AGENT_CATALOG}
        value="codex"
        onValueChange={vi.fn()}
        surfaceRows={{ model: observation.model, selection, surface: 'terminal', onPick: vi.fn() }}
      />
    )
  }
  render(<Picker />, { wrapper: TooltipProvider })
  // Starting the terminal waits; choosing another surface in the picker does not.
  expect(ready).toBe(false)
  expect(screen.getByRole('combobox').hasAttribute('disabled')).toBe(false)
})

it.each([1, 10])(
  'unrelated store writes visit no repos and re-render no picker (x%i contexts and repos)',
  async (scale) => {
    seedSshWorkspace()
    useAppStore.setState({
      sshConnectionStates: new Map([['box', { ...sshState, status: 'connected' as const }]])
    })
    let visits = 0
    const repos = Array.from({ length: 20 * scale }, (_, index) => {
      const id = `r${index}`
      const row = { ...repo, path: `/${id}` }
      return Object.defineProperty(row, 'id', {
        enumerable: true,
        get: () => {
          visits += 1
          return id
        }
      })
    })
    useAppStore.setState({ repos })
    let renders = 0
    const hooks = Array.from({ length: 2 * scale }, (_, index) =>
      renderHook(() => {
        renders += 1
        return useAgentMenuObservation(
          sourceControlRepoAgentRows(repos[index] ?? null).target,
          false,
          { kind: 'ssh', connectionId: 'box' }
        )
      })
    )
    await act(async () => {})
    const settledRenders = renders
    visits = 0
    for (const update of [
      () => useAppStore.setState({ ptyIdsByTabId: { unrelated: ['pty'] } }),
      () => useAppStore.setState({ rightSidebarWidth: 412 })
    ]) {
      await act(async () => update())
    }
    expect(visits).toBe(0)
    expect(renders).toBe(settledRenders)
    await act(async () =>
      useAppStore.setState({ sshConnectionStates: new Map([['box', sshState]]) })
    )
    expect(hooks[0]?.result.current.model).toMatchObject({ terminalPending: true })
    for (const hook of hooks) {
      hook.unmount()
    }
  }
)
