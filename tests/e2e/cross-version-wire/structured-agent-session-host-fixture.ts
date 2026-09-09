import { vi } from 'vitest'

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
