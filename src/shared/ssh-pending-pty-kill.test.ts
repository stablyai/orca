import { describe, expect, it } from 'vitest'
import {
  decideSshPendingPtyKill,
  MAX_SSH_PENDING_PTY_KILLS_PER_TARGET,
  prunePendingSshPtyKills,
  SSH_PENDING_PTY_KILL_TTL_MS,
  type SshPendingPtyKill,
  type SshPendingPtyKillEntry
} from './ssh-pending-pty-kill'

const NOW = 1_800_000_000_000

function intent(overrides: Partial<SshPendingPtyKill> = {}): SshPendingPtyKill {
  return { requestedAt: NOW, incarnationId: 'inc-a', attempts: 0, ...overrides }
}

describe('decideSshPendingPtyKill', () => {
  it('replays only when the host still holds the exact incarnation the kill was aimed at', () => {
    expect(
      decideSshPendingPtyKill(intent(), { hostListsPty: true, hostIncarnationId: 'inc-a' }, NOW)
    ).toEqual({ action: 'replay' })
  })

  // The #16970 collision: a redeployed relay renumbers from pty-1, so the same id can name a
  // different shell. Replaying here would kill a terminal nobody asked to close.
  it('retires without killing when the relay id was recycled onto another PTY', () => {
    expect(
      decideSshPendingPtyKill(intent(), { hostListsPty: true, hostIncarnationId: 'inc-b' }, NOW)
    ).toEqual({ action: 'retire', reason: 'relay-id-recycled' })
  })

  it('retires when the owning host answers and does not list the PTY', () => {
    expect(
      decideSshPendingPtyKill(
        intent(),
        { hostListsPty: false, hostIncarnationId: undefined },
        NOW + 1000
      )
    ).toEqual({ action: 'retire', reason: 'host-reports-absent' })
  })

  // TTL retirement belongs to the durable prune, not to a branch here — a branch would be
  // unreachable behind it and would only look tested. This guards the belt-and-braces refusal:
  // an expired order that somehow reaches this function is never dispatched.
  it('refuses to replay past the TTL, ahead of every other branch', () => {
    const stale = intent()
    const later = NOW + SSH_PENDING_PTY_KILL_TTL_MS + 1
    expect(
      decideSshPendingPtyKill(stale, { hostListsPty: true, hostIncarnationId: 'inc-a' }, later)
        .action
    ).toBe('defer')
    expect(
      decideSshPendingPtyKill(stale, { hostListsPty: true, hostIncarnationId: 'inc-a' }, NOW + 1)
    ).toEqual({ action: 'replay' })
  })

  // Wire skew: a host predating the published PTY incarnation leaves the fence unanswerable.
  // Absence must read as unknown, never as a match and never as a recycle.
  it('defers rather than guessing when the host published no incarnation', () => {
    expect(
      decideSshPendingPtyKill(intent(), { hostListsPty: true, hostIncarnationId: undefined }, NOW)
        .action
    ).toBe('defer')
  })
})

describe('prunePendingSshPtyKills', () => {
  it('drops expired entries and caps the rest newest-first', () => {
    const entries: SshPendingPtyKillEntry[] = [
      {
        ptyId: 'pty-stale',
        intent: intent({ requestedAt: NOW - SSH_PENDING_PTY_KILL_TTL_MS - 1 })
      },
      ...Array.from({ length: MAX_SSH_PENDING_PTY_KILLS_PER_TARGET + 25 }, (_, index) => ({
        ptyId: `pty-${index}`,
        intent: intent({ requestedAt: NOW - index })
      }))
    ]
    const pruned = prunePendingSshPtyKills(entries, NOW)
    expect(pruned).toHaveLength(MAX_SSH_PENDING_PTY_KILLS_PER_TARGET)
    expect(pruned.map((entry) => entry.ptyId)).not.toContain('pty-stale')
    expect(pruned[0]?.ptyId).toBe('pty-0')
  })
})
