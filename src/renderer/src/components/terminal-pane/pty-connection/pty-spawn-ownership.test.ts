import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  beginPtySpawnOwnership,
  finishPtySpawnOwnership,
  PTY_SPAWN_OWNERSHIP_SETTLE_TIMEOUT_MS,
  publishPtySpawnOwnership,
  resetPtySpawnOwnershipForTests,
  successorOwnsPtySpawnResult
} from './pty-spawn-ownership'

describe('pty spawn retirement ownership', () => {
  beforeEach(() => resetPtySpawnOwnershipForTests())
  afterEach(() => vi.useRealTimers())

  it('waits for a staggered sibling result before deciding retirement', async () => {
    const predecessor = beginPtySpawnOwnership('tab:leaf')!
    const successor = beginPtySpawnOwnership('tab:leaf')!
    publishPtySpawnOwnership(predecessor, { id: 'late-live-pty', incarnationId: 'inc-1' })

    let settled = false
    const decision = successorOwnsPtySpawnResult(predecessor, {
      id: 'late-live-pty',
      incarnationId: 'inc-1'
    }).then((owns) => {
      settled = true
      return owns
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    publishPtySpawnOwnership(successor, {
      id: 'late-live-pty',
      isReattach: true,
      incarnationId: 'inc-1'
    })
    expect(await decision).toBe(true)

    finishPtySpawnOwnership(successor)
    finishPtySpawnOwnership(predecessor)
  })

  it('retires when a concurrent sibling returns a different fresh PTY', async () => {
    const predecessor = beginPtySpawnOwnership('tab:leaf')!
    const successor = beginPtySpawnOwnership('tab:leaf')!
    publishPtySpawnOwnership(predecessor, { id: 'old-pty' })
    const decision = successorOwnsPtySpawnResult(predecessor, { id: 'old-pty' })
    publishPtySpawnOwnership(successor, { id: 'new-pty' })

    expect(await decision).toBe(false)
    finishPtySpawnOwnership(successor)
    finishPtySpawnOwnership(predecessor)
  })

  it('does not deadlock when both stale attempts reject their results', async () => {
    const predecessor = beginPtySpawnOwnership('tab:leaf')!
    const successor = beginPtySpawnOwnership('tab:leaf')!
    const predecessorDecision = successorOwnsPtySpawnResult(predecessor, { id: 'old-pty' })
    publishPtySpawnOwnership(predecessor, { id: 'old-pty' }, { accepted: false })
    const successorDecision = successorOwnsPtySpawnResult(successor, { id: 'old-pty' })
    publishPtySpawnOwnership(successor, { id: 'old-pty', isReattach: true }, { accepted: false })

    expect(await predecessorDecision).toBe(false)
    expect(await successorDecision).toBe(false)
    finishPtySpawnOwnership(successor)
    finishPtySpawnOwnership(predecessor)
  })

  it('bounds an unresolved sibling without retaining its PTY forever', async () => {
    vi.useFakeTimers()
    const predecessor = beginPtySpawnOwnership('tab:leaf')!
    const successor = beginPtySpawnOwnership('tab:leaf')!
    publishPtySpawnOwnership(predecessor, { id: 'late-pty' })
    const decision = successorOwnsPtySpawnResult(predecessor, { id: 'late-pty' })

    await vi.advanceTimersByTimeAsync(PTY_SPAWN_OWNERSHIP_SETTLE_TIMEOUT_MS)

    expect(await decision).toBe(false)
    finishPtySpawnOwnership(successor)
    finishPtySpawnOwnership(predecessor)
  })
})
