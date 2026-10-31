// @vitest-environment happy-dom
import { EVERY_AGENT_CHAT } from '../../../../shared/native-chat/every-agent-chat.test-fixture'
import { act, cleanup, renderHook } from '@testing-library/react'
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
} from '../../../../shared/protocol-version'
import { useAgentMenuObservation, useNewTabAgentMenuRows } from './use-new-tab-agent-menu-rows'
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
