import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as RemoteRuntimePtyIdModule from '../../../shared/remote-runtime/remote-runtime-pty-id'

type LegacyState = {
  mounted: { lines: string[]; alternateScreen: boolean } | null
  hostRead: { tail: string[]; source?: string } | null
  observer: ((data: string) => void) | null
}
const state = vi.hoisted((): LegacyState => ({ mounted: null, hostRead: null, observer: null }))

vi.mock('../../../shared/remote-runtime/remote-runtime-pty-id', async (importOriginal) => ({
  ...(await importOriginal<typeof RemoteRuntimePtyIdModule>()),
  isRemoteRuntimePtyId: () => true
}))
vi.mock('@/components/terminal-pane/pty-buffer-serializer', () => ({
  readPtyInputScreen: async () => state.mounted,
  readPtyBracketedPasteMode: () => false
}))
vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  inspectRuntimeTerminalProcess: async () => ({ verdict: 'unverifiable' })
}))
vi.mock('@/runtime/runtime-terminal-stream', () => ({
  getRemoteRuntimePtyOwner: () => ({
    target: { kind: 'environment', environmentId: 'e' },
    terminal: 't'
  }),
  subscribeToRuntimeTerminalData: (
    _ptyId: string,
    _key: string,
    observer: (data: string) => void
  ) => {
    state.observer = observer
    return () => {}
  }
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: async () => {
    if (!state.hostRead) {
      throw new Error('method not found')
    }
    return { terminal: state.hostRead }
  }
}))
vi.mock('@/components/terminal-pane/pty-data-sidecar-subscriptions', () => ({
  subscribeToPtyData: () => () => {}
}))

const { agentInputIsAdmitted, forgetLegacyTail, waitForAgentDraftInputReady } =
  await import('./agent-draft-readiness')

const PTY = 'remote:e@@t'
const DIALOG = 'Allow this command?\n[y] Approve   [n] Deny'

beforeEach(() => {
  state.mounted = null
  state.hostRead = null
  state.observer = null
  forgetLegacyTail(PTY)
})

// An older paired host with an unmounted pane: what it can still show decides, then the blind policy.
describe('an older host with no mounted pane', () => {
  it("refuses on a dialog in the host's own screen, and ignores a stream-sourced read", async () => {
    state.hostRead = { tail: DIALOG.split('\n'), source: 'screen' }
    await expect(agentInputIsAdmitted(PTY, 'claude')).resolves.toBe(false)
    state.hostRead = { tail: DIALOG.split('\n'), source: 'stream' }
    await expect(agentInputIsAdmitted(PTY, 'claude')).resolves.toBe(true)
  })

  it('refuses on a dialog streamed since the last handoff, not on one before it', async () => {
    const waiting = waitForAgentDraftInputReady(
      PTY,
      200,
      'claude-composer-prompt',
      'claude',
      undefined,
      '',
      'startup'
    )
    await vi.waitFor(() => expect(state.observer).not.toBeNull())
    state.observer!(DIALOG)
    await expect(agentInputIsAdmitted(PTY, 'claude')).resolves.toBe(false)
    state.observer!('\x1b[?2004l\x1b[?2004h> ')
    await expect(agentInputIsAdmitted(PTY, 'claude')).resolves.toBe(true)
    await waiting
  })

  it('delivers as before when nothing at all can be observed, under the blind policy', async () => {
    await expect(agentInputIsAdmitted(PTY, 'claude')).resolves.toBe(true)
  })
})
