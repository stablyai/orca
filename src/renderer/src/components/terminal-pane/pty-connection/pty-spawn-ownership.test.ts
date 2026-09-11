import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  beginPtySpawnOwnership,
  finishPtySpawnOwnership,
  hasPtySpawnOwnershipClaim,
  PTY_SPAWN_OWNERSHIP_RECORD_RETENTION_TIMEOUT_MS,
  PTY_SPAWN_OWNERSHIP_SETTLE_TIMEOUT_MS,
  publishPtySpawnOwnership,
  resetPtySpawnOwnershipForTests,
  releasePtySpawnOwnership,
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

  it('observes a later generation that claims while an earlier sibling is stalled', async () => {
    const predecessor = beginPtySpawnOwnership('tab:leaf')!
    beginPtySpawnOwnership('tab:leaf')
    publishPtySpawnOwnership(predecessor, { id: 'late-live-pty', incarnationId: 'inc-1' })

    const decision = successorOwnsPtySpawnResult(predecessor, {
      id: 'late-live-pty',
      incarnationId: 'inc-1'
    })
    await Promise.resolve()

    const laterSuccessor = beginPtySpawnOwnership('tab:leaf')!
    publishPtySpawnOwnership(laterSuccessor, {
      id: 'late-live-pty',
      isReattach: true,
      incarnationId: 'inc-1'
    })

    expect(await decision).toBe(true)
    finishPtySpawnOwnership(laterSuccessor)
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

    await vi.advanceTimersByTimeAsync(PTY_SPAWN_OWNERSHIP_RECORD_RETENTION_TIMEOUT_MS)

    expect(await decision).toBe(false)
    const fresh = beginPtySpawnOwnership('tab:leaf')!
    publishPtySpawnOwnership(fresh, { id: 'different-pty' })
    expect(await successorOwnsPtySpawnResult(fresh, { id: 'different-pty' })).toBe(false)
    finishPtySpawnOwnership(fresh)
    finishPtySpawnOwnership(successor)
    finishPtySpawnOwnership(predecessor)
  })

  it('keeps a handoff claim eligible at the ownership deadline', async () => {
    vi.useFakeTimers()
    const predecessor = beginPtySpawnOwnership('tab:leaf')!
    const successor = beginPtySpawnOwnership('tab:leaf')!
    publishPtySpawnOwnership(predecessor, { id: 'late-pty' })
    const decision = successorOwnsPtySpawnResult(predecessor, { id: 'late-pty' })

    await vi.advanceTimersByTimeAsync(PTY_SPAWN_OWNERSHIP_SETTLE_TIMEOUT_MS)
    publishPtySpawnOwnership(successor, { id: 'late-pty', isReattach: true })

    expect(await decision).toBe(true)
    finishPtySpawnOwnership(successor)
    finishPtySpawnOwnership(predecessor)
  })

  it('ignores an older accepted claim for a newer predecessor', async () => {
    const older = beginPtySpawnOwnership('tab:leaf')!
    const blocker = beginPtySpawnOwnership('tab:leaf')!
    publishPtySpawnOwnership(older, { id: 'recycled-pty', isReattach: true })
    finishPtySpawnOwnership(older)

    const predecessor = beginPtySpawnOwnership('tab:leaf')!
    publishPtySpawnOwnership(predecessor, { id: 'recycled-pty' }, { accepted: false })
    const decision = successorOwnsPtySpawnResult(predecessor, { id: 'recycled-pty' })
    finishPtySpawnOwnership(blocker)

    expect(await decision).toBe(false)
    finishPtySpawnOwnership(predecessor)
  })

  it('keeps a rejected predecessor record through transport teardown', async () => {
    const predecessor = beginPtySpawnOwnership('tab:leaf')!
    const successor = beginPtySpawnOwnership('tab:leaf')!
    publishPtySpawnOwnership(predecessor, { id: 'late-pty' }, { accepted: false })
    releasePtySpawnOwnership(predecessor)

    publishPtySpawnOwnership(successor, { id: 'late-pty', isReattach: true })
    expect(await successorOwnsPtySpawnResult(predecessor, { id: 'late-pty' })).toBe(true)
    finishPtySpawnOwnership(successor)
    finishPtySpawnOwnership(predecessor)
  })

  it('releases completed claims when the pane has no pending attempts', () => {
    vi.useFakeTimers()
    const attempt = beginPtySpawnOwnership('tab:leaf')!
    publishPtySpawnOwnership(attempt, { id: 'live-pty', isReattach: true })
    expect(hasPtySpawnOwnershipClaim(attempt)).toBe(true)

    finishPtySpawnOwnership(attempt)

    expect(hasPtySpawnOwnershipClaim(attempt)).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('clears a completed sibling timer while another attempt remains pending', () => {
    vi.useFakeTimers()
    const completed = beginPtySpawnOwnership('tab:leaf')!
    beginPtySpawnOwnership('tab:leaf')

    finishPtySpawnOwnership(completed)

    expect(vi.getTimerCount()).toBe(1)
  })
})
