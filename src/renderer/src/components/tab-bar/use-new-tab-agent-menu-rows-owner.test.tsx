// @vitest-environment happy-dom
import { EVERY_AGENT_CHAT } from '../../../../shared/native-chat/every-agent-chat.test-fixture'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi, type MockInstance } from 'vitest'
import { useAppStore } from '@/store'
import { useAgentDetectionTargetForWorktree } from '@/hooks/useAgentDetectionTarget'
import { workspaceKindForWorktreeId } from '@/lib/agent-launch-route-input'
import { getLocalAgentPreflightContext } from '@/lib/local-preflight-context'
import { localAgentInventoryContextKey } from '@/lib/local-preflight-context-key'
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
    type DetectAgents = Window['api']['preflight']['detectAgents']
    const reply = Promise.withResolvers<Awaited<ReturnType<DetectAgents>>>()
    const detected: Awaited<ReturnType<DetectAgents>> = ['claude']
    const detectAgents = vi.fn<DetectAgents>(() => reply.promise)
    const originalApi = Object.getOwnPropertyDescriptor(window, 'api')
    const originalEnsure = useAppStore.getState().ensureDetectedAgents
    const otherHost = vi.fn(async () => [])
    const getStatus = vi.fn()
    let ensure: MockInstance<AppState['ensureDetectedAgents']> | undefined
    let unmount: (() => void) | undefined
    try {
      useAppStore.getState().clearLocalDetectedAgents()
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: { runtime: { getStatus }, preflight: { detectAgents } }
      })
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
        ensureRemoteDetectedAgents: otherHost,
        ensureRuntimeDetectedAgents: otherHost,
        ...rows
      })
      const local = vi.spyOn(useAppStore.getState(), 'ensureDetectedAgents')
      ensure = local
      const hook = renderHook(() => {
        const target = useAgentDetectionTargetForWorktree(worktreeId)
        const workspace = { kind: workspaceKindForWorktreeId(worktreeId), worktreeId }
        return {
          form: useAgentMenuObservation({ workspace }, true, target),
          plus: useNewTabAgentMenuRows(worktreeId, true, target)
        }
      })
      unmount = hook.unmount
      expect(hook.result.current.form.detection).toMatchObject({
        detectedIds: [],
        isLoading: false
      })
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
      for (const probe of [local, detectAgents, otherHost, getStatus]) {
        expect(probe).not.toHaveBeenCalled()
      }
      await act(async () => {
        setLocalRuntimeCapabilitiesForTests([CHAT, CLIENT])
        useAppStore.setState({
          folderWorkspaces: [{ ...folder, executionHostId: 'local' }],
          repos: [repo],
          worktreesByRepo: {
            r1: [
              makeWorktree({ id: worktreeId, repoId: 'r1', hostId: 'local', path: '/work/local' })
            ]
          },
          detectedAgentIds: null
        })
      })
      const expectedContext = getLocalAgentPreflightContext(useAppStore.getState())
      const expectedKey = localAgentInventoryContextKey(expectedContext)
      expect(useAppStore.getState().readLocalAgentInventory()).toEqual({
        ids: null,
        state: 'pending'
      })
      expect(useAppStore.getState().localDetectedAgentIdsByContext[expectedKey]).toBeNull()
      expect(local.mock.calls.length).toBeGreaterThan(0)
      for (const args of local.mock.calls) {
        expect(args).toEqual([undefined])
      }
      expect(detectAgents).toHaveBeenCalledExactlyOnceWith({
        ...expectedContext,
        enabledOnly: true
      })
      expect(otherHost).not.toHaveBeenCalled()
      await act(async () => {
        reply.resolve(detected)
        const completed = await Promise.all(
          local.mock.results.map((result) => {
            if (result.type !== 'return' || !(result.value instanceof Promise)) {
              throw new Error('Expected the real inventory owner to return its settlement promise')
            }
            return result.value
          })
        )
        for (const value of completed) {
          expect(value).toEqual(['claude'])
        }
      })
      expect(useAppStore.getState().readLocalAgentInventory()).toEqual({
        ids: ['claude'],
        state: 'successful'
      })
      expect(useAppStore.getState().localDetectedAgentIdsByContext[expectedKey]).toEqual(['claude'])
      expect(useAppStore.getState().detectedAgentIds).toEqual(['claude'])
      expect(hook.result.current.form.detection.detectedIds).toEqual(['claude'])
      expect(hook.result.current.form.selectionFor('claude').ready).toBe(true)
      expect(
        hook.result.current.plus.state === 'settled' && hook.result.current.plus.rows
      ).toContainEqual({ kind: 'chat', agent: 'claude', executionHostId: 'local' })
    } finally {
      try {
        await act(async () => {
          try {
            if (unmount) {
              unmount()
            } else {
              cleanup()
            }
          } finally {
            reply.resolve(detected)
            const results = ensure?.mock.results ?? []
            const drained = await Promise.allSettled(
              results.flatMap((result) => (result.type === 'return' ? [result.value] : []))
            )
            for (const result of results) {
              expect(result.type).toBe('return')
              if (result.type === 'return') {
                expect(result.value).toBeInstanceOf(Promise)
              }
            }
            for (const result of drained) {
              expect(result).toEqual({ status: 'fulfilled', value: ['claude'] })
            }
          }
        })
      } finally {
        try {
          useAppStore.getState().clearLocalDetectedAgents()
        } finally {
          try {
            ensure?.mockRestore()
          } finally {
            try {
              if (originalApi) {
                Object.defineProperty(window, 'api', originalApi)
              } else {
                Reflect.deleteProperty(window, 'api')
              }
            } finally {
              try {
                useAppStore.setState({ ensureDetectedAgents: originalEnsure })
              } finally {
                try {
                  useAppStore.setState(initial, true)
                } finally {
                  setLocalRuntimeCapabilitiesForTests(null)
                }
              }
            }
          }
        }
      }
    }
  }
})
