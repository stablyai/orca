import { describe, expect, it, vi } from 'vitest'
import type { AgentProcessIdentity, AgentProcessVerdict } from './agent-process-presence'
import {
  HELD_GUEST_WINDOW_MS,
  OWNER_PROBE_COOLDOWN_MS,
  PaneOwnerProbes
} from './agent-pane-owner-probes'

const OWNER = { pid: 4001, platform: 'linux' as const, startTime: 'boot:1' }
const HOLD = { kind: 'skip' as const, probe: OWNER }

function setup(checkOwner: () => Promise<AgentProcessVerdict | null>) {
  let now = 1_000
  let owner: AgentProcessIdentity = OWNER
  const probes = new PaneOwnerProbes({ ownerOf: () => owner, checkOwner, now: () => now })
  return {
    probes,
    advance: (ms: number) => (now += ms),
    replaceOwner: (next: AgentProcessIdentity) => (owner = next)
  }
}

describe('PaneOwnerProbes', () => {
  it('checks one owner once per window, and again after it', () => {
    const checkOwner = vi.fn(async (): Promise<AgentProcessVerdict> => 'live')
    const { probes, advance } = setup(checkOwner)
    for (let index = 0; index < 5; index += 1) {
      probes.admit('pane', HOLD, { write: vi.fn(), reapply: vi.fn() })
    }
    expect(checkOwner).toHaveBeenCalledOnce()
    advance(OWNER_PROBE_COOLDOWN_MS)
    probes.admit('pane', HOLD, { write: vi.fn(), reapply: vi.fn() })
    expect(checkOwner).toHaveBeenCalledTimes(2)
  })

  it('replays only the latest held event, whichever signal started the check', async () => {
    let release: (verdict: AgentProcessVerdict) => void = () => {}
    const { probes } = setup(
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )
    const first = vi.fn()
    const latest = vi.fn()
    probes.probe('pane', OWNER)
    probes.admit('pane', HOLD, { write: vi.fn(), reapply: first })
    probes.admit('pane', HOLD, { write: vi.fn(), reapply: latest })
    release('exited')
    await vi.waitFor(() => expect(latest).toHaveBeenCalledOnce())
    expect(first).not.toHaveBeenCalled()
  })

  it('drops a held event older than the window', async () => {
    let release: (verdict: AgentProcessVerdict) => void = () => {}
    const { probes, advance } = setup(
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )
    const reapply = vi.fn()
    probes.admit('pane', HOLD, { write: vi.fn(), reapply })
    advance(HELD_GUEST_WINDOW_MS + 1)
    release('exited')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(reapply).not.toHaveBeenCalled()
  })

  it('never replays a guest held behind an owner that is gone onto a later owner', async () => {
    const checkOwner = vi.fn(async (): Promise<AgentProcessVerdict> => 'exited')
    const { probes, replaceOwner } = setup(checkOwner)
    const reapply = vi.fn()
    checkOwner.mockResolvedValueOnce('live')
    probes.admit('pane', HOLD, { write: vi.fn(), reapply })
    await vi.waitFor(() => expect(checkOwner).toHaveBeenCalledOnce())
    replaceOwner({ ...OWNER, pid: 4002 })
    await probes.check('pane')
    expect(reapply).not.toHaveBeenCalled()
  })
})
