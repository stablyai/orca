import { expect, it, vi } from 'vitest'
import { activateWebRuntimeSessionTab } from './web-runtime-session-tab-lifecycle'
import {
  getRuntimeEnvironmentRevision,
  replaceRuntimeEnvironmentRevisions
} from './runtime-environment-revision'
import { peekWebSessionFocusIntent } from './web-session-focus-intent'
import { activateTerminalTabOnOwner } from '@/lib/terminal-tab-owner-activation'
import type { LegacyRelayBridgedPane } from '../../../shared/legacy-relay-bridge-contract'
import { stubRuntimeEnvironmentBridge } from './runtime-environment-bridge-fixture'
import { createAutomationRunWorkspaceAction } from '../components/automations/automation-run-workspace-action'
import { makeRun, makeWorktree } from '../components/automations/automations-page-fixtures'

export function registerHistoricalSessionTabActivationTests(
  mocks: {
    getState: ReturnType<typeof vi.fn>
    subscribe: ReturnType<typeof vi.fn>
    revealWorktree: ReturnType<typeof vi.fn>
  },
  { ENVIRONMENT_ID, WORKTREE_ID }: { ENVIRONMENT_ID: string; WORKTREE_ID: string }
): void {
  it('historical owner focus keeps a live legacy-relay pane without asking the server for a second shell', async () => {
    const runtimeCall = vi.fn()
    const listeners = new Set<(panes: LegacyRelayBridgedPane[]) => void>()
    const bridged: LegacyRelayBridgedPane = {
      ptyId: 'ssh:box@@recorded-pty',
      targetId: 'box',
      tabId: 'recorded-tab',
      leafId: 'recorded-leaf',
      state: 'live'
    }
    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: { call: runtimeCall },
        legacyRelayBridge: {
          listPanes: async () => [bridged],
          onPanes: (listener: (panes: LegacyRelayBridgedPane[]) => void) => {
            listeners.add(listener)
            return () => listeners.delete(listener)
          }
        }
      }
    })
    const { legacyRelayBridgedPanesListed } =
      await import('../components/terminal-pane/legacy-relay-bridge-panes')
    await legacyRelayBridgedPanesListed()
    activateTerminalTabOnOwner(
      WORKTREE_ID,
      'web-terminal-recorded-tab',
      'recorded-leaf',
      ENVIRONMENT_ID
    )
    await expect(
      activateWebRuntimeSessionTab({
        worktreeId: WORKTREE_ID,
        tabId: 'web-terminal-recorded-tab',
        leafId: 'recorded-leaf',
        environmentId: ENVIRONMENT_ID
      })
    ).resolves.toBe(true)
    await vi.waitFor(() =>
      expect(peekWebSessionFocusIntent({ environmentId: ENVIRONMENT_ID }, WORKTREE_ID)).toBeNull()
    )
    expect(runtimeCall).not.toHaveBeenCalled()
    listeners.forEach((listener) => listener([]))
  })

  it('historical owner focus does not adopt a new pairing while awaiting relay discovery', async () => {
    replaceRuntimeEnvironmentRevisions([{ id: ENVIRONMENT_ID, pairingRevision: 4, createdAt: 1 }])
    const runtimeCall = vi.fn(async (request: { expectedEnvironmentPairingRevision?: number }) =>
      request.expectedEnvironmentPairingRevision === getRuntimeEnvironmentRevision(ENVIRONMENT_ID)
        ? { id: 'activate', ok: true, result: {} }
        : {
            id: 'activate',
            ok: false,
            error: { code: 'runtime_environment_changed', message: 'Pairing changed' }
          }
    )
    stubRuntimeEnvironmentBridge({ call: runtimeCall })
    const pending = activateWebRuntimeSessionTab({
      worktreeId: WORKTREE_ID,
      tabId: 'recorded-tab',
      leafId: 'recorded-leaf',
      environmentId: ENVIRONMENT_ID,
      expectedPairingRevision: 4
    })
    replaceRuntimeEnvironmentRevisions([{ id: ENVIRONMENT_ID, pairingRevision: 5, createdAt: 1 }])
    await expect(pending).resolves.toBe(false)
    for (const [request] of runtimeCall.mock.calls) {
      expect(request.expectedEnvironmentPairingRevision).toBe(4)
    }
  })

  it.each(['owner', 'repos', 'worktrees', 'pairing', 'success'] as const)(
    'historical automation open keeps the actual owner lifecycle fenced during %s',
    async (stage) => {
      replaceRuntimeEnvironmentRevisions([{ id: ENVIRONMENT_ID, pairingRevision: 4, createdAt: 1 }])
      let release = () => {}
      const deferred = new Promise<void>((resolve) => {
        release = resolve
      })
      const runtimeCall = vi.fn(
        async (request: { method: string; expectedEnvironmentPairingRevision?: number }) => {
          expect(request.method).toBe('session.tabs.activate')
          expect(request.expectedEnvironmentPairingRevision).toBe(4)
          if (stage === 'owner' || stage === 'pairing') {
            await deferred
          }
          return request.expectedEnvironmentPairingRevision ===
            getRuntimeEnvironmentRevision(ENVIRONMENT_ID)
            ? { id: 'activate', ok: true, result: {} }
            : {
                id: 'activate',
                ok: false,
                error: { code: 'runtime_environment_changed', message: 'Pairing changed' }
              }
        }
      )
      stubRuntimeEnvironmentBridge({ call: runtimeCall })
      const listeners = new Set<() => void>()
      mocks.subscribe.mockImplementation((listener: () => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      })
      let mirrored = false
      const fetchRuntimeEnvironmentRepos = vi.fn(async () => {
        if (stage === 'repos') {
          await deferred
        }
      })
      const fetchAllWorktrees = vi.fn(async () => {
        if (stage === 'worktrees') {
          await deferred
        }
        mirrored = true
      })
      const state = {
        settings: { activeRuntimeEnvironmentId: ENVIRONMENT_ID },
        activeWorktreeId: 'original-selection',
        activeWorkspaceExecutionHostId: 'local',
        terminalLayoutsByTabId: {},
        fetchRuntimeEnvironmentRepos,
        fetchAllWorktrees
      }
      mocks.getState.mockReturnValue(state)
      // SAFETY: this action reads only runTargetFor; the rest of the page context is unused.
      const context = {
        list: {
          runTargetFor: () => ({
            worktree: mirrored ? makeWorktree({ hostId: `runtime:${ENVIRONMENT_ID}` }) : null,
            ownerEnvironmentId: ENVIRONMENT_ID,
            expectedPairingRevision: 4,
            terminalTarget: null,
            viewState: {
              canOpen: getRuntimeEnvironmentRevision(ENVIRONMENT_ID) === 4,
              availability: 'terminal' as const,
              actionLabel: 'Open',
              statusLabel: 'Open'
            }
          })
        }
      }
      createAutomationRunWorkspaceAction(context)(
        makeRun({
          workspaceId: WORKTREE_ID,
          terminalPaneKey: 'recorded-tab:11111111-1111-4111-8111-111111111111'
        })
      )
      await vi.waitFor(() => expect(runtimeCall).toHaveBeenCalledTimes(1))
      if (stage === 'repos') {
        await vi.waitFor(() => expect(fetchRuntimeEnvironmentRepos).toHaveBeenCalledTimes(1))
      }
      if (stage === 'worktrees') {
        await vi.waitFor(() => expect(fetchAllWorktrees).toHaveBeenCalledTimes(1))
      }
      if (stage === 'pairing') {
        replaceRuntimeEnvironmentRevisions([
          { id: ENVIRONMENT_ID, pairingRevision: 5, createdAt: 1 }
        ])
      } else if (stage !== 'success') {
        state.activeWorktreeId = 'later-user-selection'
        listeners.forEach((listener) => listener())
        state.activeWorktreeId = 'original-selection'
        listeners.forEach((listener) => listener())
      }
      release()
      await vi.waitFor(() => expect(listeners.size).toBe(0))
      expect(runtimeCall).toHaveBeenCalledTimes(1)
      expect(runtimeCall).toHaveBeenCalledWith(
        expect.objectContaining({
          selector: ENVIRONMENT_ID,
          expectedEnvironmentPairingRevision: 4,
          params: expect.objectContaining({
            tabId: 'recorded-tab',
            leafId: '11111111-1111-4111-8111-111111111111',
            notifyClients: false,
            navigation: 'caller'
          })
        })
      )
      expect(mocks.revealWorktree).toHaveBeenCalledTimes(stage === 'success' ? 1 : 0)
    }
  )
}
