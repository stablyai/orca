import { vi } from 'vitest'
import type { StructuredAgentSessionHost } from '../../../src/main/native-chat/agent-session-wire/structured-agent-session-host'
import { setStructuredAgentSessionHost } from '../../../src/main/native-chat/agent-session-wire/structured-agent-session-registry'
import {
  AGENT_SESSION_TURN_ITEM_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
} from '../../../src/shared/protocol-version'

/** The host every skew installs to drive the surface: enough of the real host's
 *  shape for each handler to run, and a spy per method so "which call reached the
 *  host" is answerable per call rather than per suite. */
export function structuredHostStub(
  sessionId: string,
  workspaceId: string
): Record<string, ReturnType<typeof vi.fn>> {
  return {
    // The restart-resume surface hangs off a host MEMBER rather than the root, but its spies stay
    // flat here: callers iterate this map asserting every entry is a spy that did not run, and
    // `installableHost` below is what reassembles the member. Keeping them flat also lets the
    // manifest name them to prove a call reached the host.
    restartResumableList: vi.fn(async () => []),
    restartResumableFailures: vi.fn(async () => []),
    restartResumableDismiss: vi.fn(async () => 0),
    restartResumeAll: vi.fn(async () => []),
    restartContinueAll: vi.fn(async () => ({ resumed: [], continued: [] })),
    attach: vi.fn(async () => ({ ok: true, replayed: false, value: { sessionId } })),
    // Attach-shaped entries take a client-supplied location, so the host is asked whether it
    // supports creating there. A real host always answers; leaving it unstubbed made every
    // `ensure` refuse for the harness's own reason rather than the location's.
    supportsCreate: vi.fn(() => true),
    conversationCommand: vi.fn(async () => ({
      ok: true,
      value: { command: 'compact', state: 'completed' }
    })),
    send: vi.fn(async () => ({
      ok: true,
      replayed: false,
      fence: 1,
      cursor: { epoch: 'epoch-a', sequence: 2 },
      value: {
        clientMessageId: 'client-1',
        submission: {
          clientMessageId: 'client-1',
          fence: 1,
          payloadFingerprint: 'fingerprint',
          dispatchState: 'accepted',
          providerItemId: 'provider-1',
          reason: null,
          submittedAt: 1,
          resolvedAt: 2
        }
      }
    })),
    waitForSendSettlement: vi.fn(),
    cancel: vi.fn(async () => ({ ok: true, replayed: false })),
    rewind: vi.fn(async () => ({
      ok: true,
      replayed: false,
      value: { itemId: 'item-1', epoch: 'rewound-epoch' }
    })),
    close: vi.fn(async () => undefined),
    revealSession: vi.fn(async () => ({
      sessionId,
      workspaceId,
      agent: 'codex' as const,
      readable: true
    })),
    hold: vi.fn(async () => undefined),
    release: vi.fn(() => undefined),
    respondToPrompt: vi.fn(async () => ({ ok: true, replayed: false })),
    setOption: vi.fn(async () => ({ ok: true, replayed: false })),
    changeThreadGoal: vi.fn(async () => ({ ok: true, replayed: false })),
    handoffStatus: vi.fn(async () => ({ owner: 'native' })),
    readOptions: vi.fn(async () => ({ models: [], current: { model: 'gpt-live' } })),
    modelCatalog: vi.fn(() => ({ origin: 'unknown' as const })),
    readCommands: vi.fn(() => ({ commands: [{ name: 'clear', kind: 'command' as const }] })),
    history: vi.fn(() => ({ ok: true, page: { items: [] } })),
    sessionAgent: vi.fn(() => null),
    journalSnapshot: vi.fn(() => ({
      sessionId,
      cursor: { epoch: 'epoch-a', sequence: 0 },
      items: [],
      submissions: []
    })),
    subscribe: vi.fn(() => () => undefined),
    subscribeStatus: vi.fn((subscriber: { emit: (event: unknown) => void }) => {
      subscriber.emit({ type: 'snapshot', sessions: [] })
      return () => undefined
    }),
    // No opening emit, unlike the status feed above: a completion is an edge, so this stream
    // opens empty and a subscriber that was away has missed what passed.
    subscribeTurnCompletions: vi.fn(() => () => undefined),
    unsubscribe: vi.fn()
  }
}

/** The stub shaped the way the host actually exposes it: flat spies, plus the `restartResume`
 *  member the RPC methods reach through. Install this; assert against the flat map.
 *
 *  The one assertion lives here so no call site needs its own. */
export function installableHost(
  hostCalls: Record<string, ReturnType<typeof vi.fn>>
): StructuredAgentSessionHost {
  const host = {
    ...hostCalls,
    deps: { modelCatalog: { read: hostCalls.modelCatalog } },
    restartResume: {
      list: hostCalls.restartResumableList,
      listFailures: hostCalls.restartResumableFailures,
      dismiss: hostCalls.restartResumableDismiss,
      resume: hostCalls.restartResumeAll,
      continueAfterRestart: hostCalls.restartContinueAll
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a spy map standing in for the host; the dispatcher reaches only the members stubbed above, and a missing one fails the call rather than type-checking.
  return host as unknown as StructuredAgentSessionHost
}

const TURN = { turnId: 'turn-1', state: 'completed' as const, startedAt: 1, completedAt: 6 }
const TURN_ROW = { itemId: 'legacy:codex:s:turn-1', revision: 1, sequence: 1, observedAt: 1 }

/** One completed turn the host journals, and the two ways the current host publishes it.
 *  The old client is derived from the baseline by removing the capability, so the downgrade
 *  stays exercised after a release ships it. */
export const turnItemSkew = {
  /** Installs the stub host over a history page that carries the turn row. */
  install(sessionId: string, workspaceId: string): void {
    const host = structuredHostStub(sessionId, workspaceId)
    const items = [{ ...TURN_ROW, body: { kind: 'turn', ...TURN } }]
    host.history.mockReturnValue({ ok: true, page: { items } })
    setStructuredAgentSessionHost(installableHost(host))
  },
  /** Each skew's advertised list and the item it must be published. */
  clients(
    baseline: { capabilities: readonly string[] },
    current: { capabilities: readonly string[] }
  ) {
    const old = baseline.capabilities.filter((c) => c !== AGENT_SESSION_TURN_ITEM_CAPABILITY)
    return [
      [
        [...old, STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY],
        { ...TURN_ROW, body: { kind: 'status', turnLifecycle: TURN } }
      ],
      [[...current.capabilities], { ...TURN_ROW, body: { kind: 'turn', ...TURN } }]
    ] as const
  }
}
