import { expect, it, vi, type Mock } from 'vitest'
import type { AutomationRun } from '../../../../shared/automations-types'
import type { Tab } from '../../../../shared/tab-types'
import { makeUnifiedTab } from '@/store/slices/store-test-helpers'
import {
  activateAiVaultStructuredSession,
  openDesktopStructuredSession
} from '@/lib/activate-ai-vault-structured-session'

export function installAutomationRunInteractionCases<T>({
  mocks,
  run,
  workspaceId: WT,
  environmentId: ENV,
  groupId: GROUP,
  seedChat,
  mount,
  open
}: {
  mocks: {
    state: Record<string, unknown>
    chatTabs: Tab[]
    activateTab: Mock
    rpc: Mock
    activate: Mock
    ownerActivate: Mock
    toastMessage: Mock
    toastError: Mock
  }
  run: AutomationRun
  workspaceId: string
  environmentId: string
  groupId: string
  seedChat: () => T
  mount: (input: T, run: AutomationRun) => Promise<unknown>
  open: (run: AutomationRun) => void
}): void {
  it('presents one semantic automation fallback for a real exact activation throw and permits retry', async () => {
    const input = seedChat()
    mocks.chatTabs.push(
      makeUnifiedTab({
        id: 'recorded-chat',
        groupId: GROUP,
        entityId: 'claude_published',
        worktreeId: WT,
        executionHostId: `runtime:${ENV}`,
        contentType: 'agent-session'
      })
    )
    mocks.state.focusGroup = vi.fn(() => {
      throw new Error('activation unavailable')
    })
    const recorded = {
      ...run,
      sessionKind: 'chat' as const,
      chatSessionId: 'claude_published',
      terminalSessionId: null,
      terminalPaneKey: null,
      terminalPtyId: null
    }
    await mount(input, recorded)
    open(recorded)
    open(recorded)
    await vi.waitFor(() =>
      expect(mocks.toastMessage).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining('saved output remains')
      )
    )
    expect(mocks.toastError).not.toHaveBeenCalled()
    expect(mocks.ownerActivate).not.toHaveBeenCalled()
    expect(mocks.rpc).not.toHaveBeenCalled()
    expect(mocks.activate).toHaveBeenCalledExactlyOnceWith(WT, {
      executionHostId: `runtime:${ENV}`,
      runtimeEnvironmentId: ENV,
      providesInitialSurface: true
    })
    mocks.state.focusGroup = vi.fn()
    open(recorded)
    await vi.waitFor(() => expect(mocks.activateTab).toHaveBeenCalledOnce())
    expect(mocks.toastMessage).toHaveBeenCalledOnce()
  })

  it.each([false, true])(
    'opens actual successor/provider with only first-owner navigation, including late joins; History first=%s',
    async (historyFirst) => {
      const input = seedChat()
      const requested = 'claude_recorded'
      const actualWorkspace = 'repo-a::/srv/successor'
      const actualSession = 'codex_successor'
      const recorded: AutomationRun = {
        ...run,
        sessionKind: 'chat',
        chatSessionId: requested,
        terminalSessionId: null,
        terminalPaneKey: null,
        terminalPtyId: null,
        outputSnapshot: {
          format: 'plain_text',
          content: 'Saved output',
          truncated: false,
          capturedAt: 1
        }
      }
      await mount(input, recorded)
      const before = structuredClone(recorded)
      const target = { kind: 'environment', environmentId: ENV } as const
      const pointer = { workspaceId: WT, sessionId: requested }
      const release = Promise.withResolvers<void>()
      const revealing = Promise.withResolvers<void>()
      const actualTabs: Tab[] = []
      mocks.state.unifiedTabsByWorktree = { [WT]: mocks.chatTabs, [actualWorkspace]: actualTabs }
      mocks.rpc.mockImplementation(async (_target, method: string) => {
        if (method === 'orchestration.partyLocation') {
          return {
            location: { kind: 'chat', sessionId: actualSession, worktreeId: actualWorkspace }
          }
        }
        if (method === 'agentSession.reveal') {
          revealing.resolve()
          await release.promise
          // A late stale requested row must not replace the actual receipt/provider.
          mocks.chatTabs.push(
            makeUnifiedTab({
              id: 'stale-requested',
              groupId: GROUP,
              entityId: requested,
              worktreeId: WT,
              executionHostId: `runtime:${ENV}`,
              contentType: 'agent-session'
            })
          )
          actualTabs.push(
            makeUnifiedTab({
              id: 'actual-issued',
              groupId: GROUP,
              entityId: actualSession,
              worktreeId: actualWorkspace,
              executionHostId: `runtime:${ENV}`,
              contentType: 'agent-session',
              agentSessionAgent: 'codex'
            })
          )
          return {
            ok: true,
            sessionId: actualSession,
            workspaceId: actualWorkspace,
            agent: 'codex'
          }
        }
        return { ok: true }
      })
      const late: string[] = []
      mocks.activate.mockImplementation((workspace?: string) => {
        mocks.state.activeWorktreeId = workspace
        if (workspace === actualWorkspace) {
          late.push('sync')
          open(recorded)
          queueMicrotask(() => {
            late.push('microtask')
            open(recorded)
          })
        }
        return true
      })
      const history = () =>
        activateAiVaultStructuredSession({ structuredSession: pointer }, undefined, target)
      let handled: Promise<boolean>
      if (historyFirst) {
        handled = history()
        await revealing.promise
        open(recorded)
      } else {
        open(recorded)
        await revealing.promise
        handled = history()
      }
      const rich = openDesktopStructuredSession(
        { kind: 'history', structuredSession: pointer },
        target
      )
      release.resolve()
      expect(await handled).toBe(true)
      expect(await rich).toEqual({
        kind: 'opened',
        target: { sessionId: actualSession, worktreeId: actualWorkspace, agent: 'codex' },
        tab: { id: 'actual-issued', sessionId: actualSession, agent: 'codex' }
      })
      expect(late).toEqual(['sync', 'microtask'])
      expect(mocks.state.activeWorktreeId).toBe(actualWorkspace)
      expect(mocks.activate.mock.calls).toEqual(
        historyFirst
          ? [[actualWorkspace]]
          : [
              [
                WT,
                {
                  executionHostId: `runtime:${ENV}`,
                  runtimeEnvironmentId: ENV,
                  providesInitialSurface: true
                }
              ],
              [
                actualWorkspace,
                {
                  executionHostId: `runtime:${ENV}`,
                  runtimeEnvironmentId: ENV,
                  providesInitialSurface: true
                }
              ]
            ]
      )
      expect(mocks.activateTab).toHaveBeenCalledExactlyOnceWith('actual-issued', {
        worktreeId: actualWorkspace
      })
      expect(mocks.state.focusGroup).toHaveBeenCalledExactlyOnceWith(actualWorkspace, GROUP)
      expect(
        mocks.rpc.mock.calls.filter(([, method]) => method === 'agentSession.reveal')
      ).toHaveLength(1)
      expect(
        mocks.rpc.mock.calls.filter(([, method]) => method === 'session.tabs.activate')
      ).toHaveLength(1)
      expect(mocks.rpc.mock.calls.every(([, method]) => !/create|send|launch/.test(method))).toBe(
        true
      )
      expect(mocks.toastError).not.toHaveBeenCalled()
      expect(mocks.toastMessage).not.toHaveBeenCalled()
      expect(recorded).toEqual(before)
    }
  )

  it('refuses owner-only workspace initialization before engine and releases for a real retry', async () => {
    const input = seedChat()
    const recorded: AutomationRun = {
      ...run,
      sessionKind: 'chat',
      chatSessionId: 'claude_recorded',
      terminalSessionId: null,
      terminalPaneKey: null,
      terminalPtyId: null
    }
    mocks.activate.mockReturnValueOnce(false)
    await mount(input, recorded)
    open(recorded)
    open(recorded)
    const result = await openDesktopStructuredSession(
      {
        kind: 'history',
        structuredSession: {
          workspaceId: WT,
          sessionId: 'claude_recorded'
        }
      },
      { kind: 'environment', environmentId: ENV }
    )
    expect(result).toEqual({
      kind: 'failed',
      failure: { reason: 'unreachable', beforeEffects: true }
    })
    expect(mocks.activate).toHaveBeenCalledExactlyOnceWith(WT, {
      executionHostId: `runtime:${ENV}`,
      runtimeEnvironmentId: ENV,
      providesInitialSurface: true
    })
    expect(mocks.toastError).toHaveBeenCalledExactlyOnceWith('Workspace is not available.')
    expect(mocks.toastMessage).not.toHaveBeenCalled()
    expect(mocks.rpc).not.toHaveBeenCalled()
    expect(mocks.activateTab).not.toHaveBeenCalled()
    open(recorded)
    await vi.waitFor(() => expect(mocks.activateTab).toHaveBeenCalledOnce())
    expect(mocks.toastError).toHaveBeenCalledOnce()
    expect(mocks.toastMessage).not.toHaveBeenCalled()
  })
}
