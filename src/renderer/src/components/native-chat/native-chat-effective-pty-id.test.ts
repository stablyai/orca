import { describe, it, expect } from 'vitest'
import { resolveEffectiveChatPanePtyId } from './native-chat-effective-pty-id'

describe('resolveEffectiveChatPanePtyId', () => {
  it('prefers the transport-connected ptyId when the transport has one', () => {
    expect(resolveEffectiveChatPanePtyId('transport-pty', 'layout-pty')).toBe('transport-pty')
  })

  it('falls back to the layout binding when the transport has never connected (Decision 1 kill, or an RPC hand-back/restore the transport was never told about)', () => {
    expect(resolveEffectiveChatPanePtyId(null, 'layout-pty')).toBe('layout-pty')
  })

  it('returns null when neither source has a value', () => {
    expect(resolveEffectiveChatPanePtyId(null, null)).toBeNull()
  })

  it('returns null when the layout binding is entirely absent (undefined, not just null)', () => {
    expect(resolveEffectiveChatPanePtyId(null, undefined)).toBeNull()
  })

  // Wave 11: models the exact live-UAT scenario — kill-and-resume acquire
  // (transport genuinely disconnects), a hand-back respawn the transport is
  // never told about (layout rebinds, transport stays null), then a second
  // acquire's own kill/failed-acquire/restore cycle. The composer's D1
  // degrade contract must hold at every step: enabled whenever either a
  // real send route (RPC ownership) or a live pty (this resolver) exists.
  it('threads a full acquire -> hand-back -> acquire-fails -> restored cycle to a live pty at every step the store says one exists', () => {
    // Before any RPC use: ordinary terminal, transport genuinely connected.
    expect(resolveEffectiveChatPanePtyId('pty-1', 'pty-1')).toBe('pty-1')

    // Cycle 1 acquire: Decision 1 kills pty-1. The transport observes the
    // real exit and nulls itself; killPtyBeforeOmpRpcAcquire proactively
    // clears both store-side bindings too — no live pty anywhere.
    expect(resolveEffectiveChatPanePtyId(null, undefined)).toBeNull()

    // Hand-back: respawnPtyForOmpRpcChatHandback spawns pty-2 and rebinds
    // both store-side bindings (verified symmetric, wave 10) — but never
    // touches the transport, which stays disconnected.
    expect(resolveEffectiveChatPanePtyId(null, 'pty-2')).toBe('pty-2')

    // Cycle 2 acquire kills pty-2 (same transport-disconnect story) ...
    expect(resolveEffectiveChatPanePtyId(null, undefined)).toBeNull()

    // ... acquire fails, and the D1 fail-closed restore respawns pty-3 and
    // rebinds both store-side bindings again — the exact live-UAT bug: the
    // store shows a live pty, the transport still does not.
    expect(resolveEffectiveChatPanePtyId(null, 'pty-3')).toBe('pty-3')
  })
})
