// @vitest-environment happy-dom
// END-PASS CHAT-RENEW: a chat that already ran (status entry, now idle after its turn) whose Claude
// sign-in is revoked or put in question must show the expired strip and hold Send. Unlike
// cloud-chat-running-strip.test.tsx, the decision here is the REAL one: cloudRunningStrip plus the D13
// Sources read (useWorkspaceUsesAccount through window.api.orcaCloudAgents.workspaceSources).
import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcaCloudAgentsStatus } from '../../../../shared/orca-cloud-agents/orca-cloud-agents-wire'

const TAB_ID = 'agent-session:sess-1'
const STATUS_KEY = `${TAB_ID}:sess-1`

const world = vi.hoisted(() => {
  const value: {
    claude: OrcaCloudAgentsStatus['credentials']['claude']
    status: Record<string, unknown> | null
    sourcesCalls: number
    /** The chat tab's execution host: a mirrored tab has `runtime:<env>`, a desktop-made one may not. */
    executionHostId: string | undefined
  } = {
    claude: { state: 'active' },
    status: null,
    sourcesCalls: 0,
    executionHostId: 'runtime:env-paired'
  }
  return value
})

vi.mock('@/store', () => {
  const read = () => ({
    unifiedTabsByWorktree: {
      'wt-1': [
        {
          id: TAB_ID,
          contentType: 'agent-session',
          ...(world.executionHostId ? { executionHostId: world.executionHostId } : {})
        }
      ]
    },
    agentStatusByPaneKey: world.status ? { [STATUS_KEY]: world.status } : {}
  })
  const useAppStore = (selector: (s: ReturnType<typeof read>) => unknown): unknown =>
    selector(read())
  useAppStore.getState = read
  return { useAppStore }
})
vi.mock('@/lib/orca-cloud/orca-cloud-environment-id', () => ({
  isOrcaCloudEnvironmentId: (id: string) => id === 'env-paired'
}))
vi.mock('@/lib/orca-cloud/cloud-agent-launch-hold', () => ({ useCloudAgentHold: () => null }))
// The workspace's runtime owner (the sidebar row's rule): wt-1 runs on env-paired.
vi.mock('@/components/orca-cloud/use-cloud-agent-row-sign-in', () => ({
  orcaCloudEnvironmentIdForWorktree: (_state: unknown, worktreeId: string) =>
    worktreeId === 'wt-1' ? 'env-paired' : null
}))
vi.mock('@/lib/orca-cloud/orca-cloud-agent-accounts-store', () => ({
  orcaCloudAgentAccountsLoadedAt: () => 1_000,
  ensureFreshOrcaCloudAgentAccounts: async () => undefined,
  reloadOrcaCloudAgentAccounts: async () => undefined,
  runOrcaCloudAgentSetups: () => undefined,
  stopOrcaCloudAgentSetups: () => undefined,
  useOrcaCloudAgentAccounts: () => ({
    load: {
      kind: 'ready',
      status: {
        credentials: {
          claude: world.claude,
          codex: { state: 'none' },
          providerEnabled: { claude: true, codex: true }
        },
        sources: { defaults: {}, coveredByKey: { claude: false, codex: false } }
      }
    },
    keyKinds: { claude: null, codex: null },
    setups: { claude: { phase: 'idle' }, codex: { phase: 'idle' } }
  })
}))

const { useCloudChatAccountStrip, useCloudChatSendBlock } =
  await import('./use-cloud-chat-running-strip')
const { resetCloudRunningSignoutForTest } =
  await import('@/lib/orca-cloud/cloud-running-agent-signout')

const args = { tabId: TAB_ID, statusKey: STATUS_KEY, holdKey: 'structured:sess-1', agent: 'claude' }

beforeEach(() => {
  resetCloudRunningSignoutForTest()
  world.claude = { state: 'active' }
  world.sourcesCalls = 0
  world.executionHostId = 'runtime:env-paired'
  // A chat that already ran a turn and is idle now.
  world.status = { agentType: 'claude', state: 'done', stateStartedAt: 500 }
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      orcaCloudAgents: {
        workspaceSources: async () => {
          world.sourcesCalls += 1
          return {
            ok: true,
            value: {
              defaults: { claude: null, codex: null },
              effective: {
                claude: { source: null, origin: 'implicit' },
                codex: { source: null, origin: 'implicit' }
              },
              coveredByKey: { claude: false, codex: false },
              sharedWorkspace: false,
              workspace: { claude: null, codex: null }
            }
          }
        }
      }
    }
  })
})

describe('a running chat, idle after its turn, whose sign-in goes bad (END-PASS CHAT-RENEW)', () => {
  for (const [label, claude, host] of [
    ['revoked', { state: 'revoked' }, 'runtime:env-paired'],
    ['in question (RS-2: expired + needsCheck)', { state: 'expired' }, 'runtime:env-paired'],
    // END-PASS CHAT-RENEW: a chat tab the desktop created (held chat started from its strip) with no
    // runtime execution host: its workspace's runtime owner still makes it a cloud chat.
    ['revoked, on a desktop-made chat tab with no runtime host', { state: 'revoked' }, undefined],
    ['revoked, on a desktop-made chat tab marked local', { state: 'revoked' }, 'local']
  ] as const) {
    it(`${label}: the expired strip shows and Send is held`, async () => {
      world.executionHostId = host
      const { result, rerender } = renderHook(() => ({
        strip: useCloudChatAccountStrip(args),
        block: useCloudChatSendBlock(args)
      }))
      expect(result.current.strip).toBeNull()
      world.claude = claude
      rerender()
      await waitFor(() => expect(world.sourcesCalls).toBeGreaterThan(0))
      await waitFor(() => {
        rerender()
        expect(result.current.strip).toMatchObject({ phase: 'expired', agent: 'claude' })
      })
      expect(result.current.block).toBe('Renew Claude sign-in above to send')
    })
  }

  it('a sign-in that still reads active shows nothing (the server has not learned of a revoke yet)', () => {
    const { result } = renderHook(() => useCloudChatAccountStrip(args))
    expect(result.current).toBeNull()
    expect(world.sourcesCalls).toBe(0)
  })
})
