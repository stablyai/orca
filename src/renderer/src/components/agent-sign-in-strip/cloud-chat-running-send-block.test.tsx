// @vitest-environment happy-dom
// END-PASS CHAT-RENEW: whenever a running chat's strip is in its expired phase, the composer says
// "Renew Claude sign-in above to send" (the empty field's placeholder and Send's hint) and Send is
// disabled, typed draft or not. The decision is the REAL chain: cloudRunningStrip plus D13, through
// the chat's install slot (where NativeChatStructuredSession reads its Send block) into the
// composer's send state.
import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcaCloudAgentsStatus } from '../../../../shared/orca-cloud-agents/orca-cloud-agents-wire'
import { structuredAgentSessionPaneKey } from '../../../../shared/agent-session/view/structured-agent-session-projection'

const SESSION_ID = 'sess-1'
const TAB_ID = `agent-session:${SESSION_ID}`
const STATUS_KEY = structuredAgentSessionPaneKey(TAB_ID, SESSION_ID)
const HINT = 'Renew Claude sign-in above to send'

const world = vi.hoisted(() => {
  const value: {
    claude: OrcaCloudAgentsStatus['credentials']['claude']
    status: Record<string, unknown> | null
  } = { claude: { state: 'active' }, status: null }
  return value
})

vi.mock('@/store', () => {
  const read = () => ({
    unifiedTabsByWorktree: {
      'wt-1': [{ id: TAB_ID, contentType: 'agent-session', executionHostId: 'runtime:env-paired' }]
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
vi.mock('@/components/orca-cloud/use-cloud-agent-row-sign-in', () => ({
  orcaCloudEnvironmentIdForWorktree: () => 'env-paired'
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
// The chat runs the host's own program: no managed install, no held launch.
vi.mock('@/components/native-chat/session/status/structured-agent-session-status-hooks', () => ({
  useStructuredAgentSessionHostProgram: () => true
}))
vi.mock('@/runtime/hosts/installation/use-managed-runtime-install', () => ({
  useManagedRuntimeInstall: () => ({ kind: 'inactive' })
}))
vi.mock('./use-cloud-chat-hold-hint', () => ({ useCloudChatHoldHint: () => undefined }))

const { useNativeChatInstallSlot } =
  await import('@/components/native-chat/host-access/NativeChatInstallSlot')
const { nativeChatComposerSendState } =
  await import('@/components/native-chat/composer/submit/native-chat-composer-send-state')
const { useCloudChatAccountStrip } = await import('./use-cloud-chat-running-strip')
const { resetCloudRunningSignoutForTest } =
  await import('@/lib/orca-cloud/cloud-running-agent-signout')

const props = {
  target: { kind: 'runtime', environmentId: 'env-paired' },
  agent: 'claude',
  isVisible: true,
  sessionId: SESSION_ID,
  tabId: TAB_ID
} as const

function composer(sendBlockedReason: string | null, draft: string, heldHint?: string) {
  return nativeChatComposerSendState({
    agent: 'claude',
    draft,
    messageDelivery: true,
    imageAttachments: [],
    pastedTextSaving: false,
    disabled: false,
    structuredTransport: {
      sendOut: false,
      optionSnapshot: [],
      ...(sendBlockedReason !== null ? { sendBlockedReason } : {}),
      ...(heldHint ? { heldHint } : {})
    },
    editSession: undefined,
    isWorking: false,
    canStop: false
  })
}

beforeEach(() => {
  resetCloudRunningSignoutForTest()
  world.claude = { state: 'active' }
  // A chat launched from held (Start), that ran its turn and is idle now.
  world.status = { agentType: 'claude', state: 'done', stateStartedAt: 500 }
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      orcaCloudAgents: {
        workspaceSources: async () => ({
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
        })
      }
    }
  })
})

describe('a running idle chat whose strip is expired holds Send with its hint (END-PASS CHAT-RENEW)', () => {
  for (const [label, claude] of [
    ['revoked', { state: 'revoked' }],
    ['in question (RS-2: expired + needsCheck)', { state: 'expired' }]
  ] as const) {
    it(`${label}: placeholder and Send hint read Renew, and Send is disabled with or without a draft`, async () => {
      const { result, rerender } = renderHook(() => ({
        strip: useCloudChatAccountStrip({
          tabId: TAB_ID,
          statusKey: STATUS_KEY,
          holdKey: 'unused',
          agent: 'claude'
        }),
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the install slot reads only target/agent/isVisible/sessionId/tabId and the layout tag
        slot: useNativeChatInstallSlot(props as never, 'Claude', 'pane' as never)
      }))
      // Active: nothing holds the composer.
      expect(result.current.strip).toBeNull()
      expect(result.current.slot.sendBlockedReason).toBeNull()
      expect(result.current.slot.heldHint).toBeUndefined()
      expect(composer(null, 'hi').sendButtonDisabled).toBe(false)

      world.claude = claude
      await waitFor(() => {
        rerender()
        expect(result.current.strip).toMatchObject({ phase: 'expired', agent: 'claude' })
      })
      const { slot } = result.current
      // Typing stays open (no unavailable hint), the empty field says why Send is held.
      expect(slot.unavailableHint).toBeUndefined()
      expect(slot.heldHint).toBe(HINT)
      expect(slot.sendBlockedReason).toBe(HINT)
      for (const draft of ['', 'continue please']) {
        const state = composer(slot.sendBlockedReason, draft, slot.heldHint)
        expect(state.sendButtonDisabled).toBe(true)
        expect(state.sendHeld).toBe(true)
        expect(state.sendBlockedReason).toBe(HINT)
        // The composer field shows it as the empty field's placeholder.
        expect(state.heldHint).toBe(HINT)
      }
    })
  }
})
