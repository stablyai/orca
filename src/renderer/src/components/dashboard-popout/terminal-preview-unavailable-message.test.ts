import { describe, expect, it } from 'vitest'
import { terminalPreviewUnavailableMessage } from './terminal-preview-unavailable-message'

describe('terminalPreviewUnavailableMessage', () => {
  it('claims the pane closed only for a pty the client could have observed', () => {
    expect(terminalPreviewUnavailableMessage({ ptyId: 'pty-1' })).toMatch(/pane has closed/)
    expect(terminalPreviewUnavailableMessage({ hostKind: 'local' })).toMatch(/pane has closed/)
  })

  it('reports an unobservable remote preview instead of asserting the pane exited', () => {
    // SshPtyProvider provides no authoritative buffer snapshot and the relay has no snapshot
    // RPC, so a null snapshot is loss of contact. See docs/reference/ssh-execution-boundary.md.
    const fromPtyId = terminalPreviewUnavailableMessage({ ptyId: 'ssh:devbox@@pty-3' })
    expect(fromPtyId).toMatch(/remote session/)
    expect(fromPtyId).not.toMatch(/pane has closed/)
    expect(terminalPreviewUnavailableMessage({ hostKind: 'ssh' })).toBe(fromPtyId)
  })

  it('reports a paired-server card as remote instead of claiming its pane closed (#25688)', () => {
    const remote = terminalPreviewUnavailableMessage({ hostKind: 'ssh' })
    expect(terminalPreviewUnavailableMessage({ hostKind: 'remote' })).toBe(remote)
    expect(terminalPreviewUnavailableMessage({ ptyId: 'remote:env-1@@term_1' })).toBe(remote)
    expect(terminalPreviewUnavailableMessage({ ptyId: 'remote:term_1' })).toBe(remote)
  })
})
