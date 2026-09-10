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
    attach: vi.fn(async () => ({ ok: true, replayed: false, value: { sessionId } })),
    // Attach-shaped entries take a client-supplied location, so the host is asked whether it
    // supports creating there. A real host always answers; leaving it unstubbed made every
    // `ensure` refuse for the harness's own reason rather than the location's.
    supportsCreate: vi.fn(() => true),
    conversationCommand: vi.fn(async () => ({
      ok: true,
      value: { command: 'compact', state: 'completed' }
    })),
    send: vi.fn(async () => ({ ok: true, replayed: false })),
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
    requestHandoff: vi.fn(async () => ({ status: { owner: 'native' } })),
    handoffStatus: vi.fn(async () => ({ owner: 'native' })),
    readOptions: vi.fn(async () => ({ models: [], current: { model: 'gpt-live' } })),
    readCommands: vi.fn(() => ({ commands: [{ name: 'clear', kind: 'command' as const }] })),
    history: vi.fn(() => ({ ok: true, page: { items: [] } })),
    subscribe: vi.fn(() => () => undefined),
    subscribeStatus: vi.fn((subscriber: { emit: (event: unknown) => void }) => {
      subscriber.emit({ type: 'snapshot', sessions: [] })
      return () => undefined
    }),
    unsubscribe: vi.fn()
  }
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
    setStructuredAgentSessionHost(host as unknown as StructuredAgentSessionHost)
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
