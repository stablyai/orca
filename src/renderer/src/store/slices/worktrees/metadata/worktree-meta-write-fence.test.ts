import { describe, expect, it, vi } from 'vitest'
import { MetaWriteFence } from './worktree-meta-write-fence'

function fenceAt(start: number) {
  let now = start
  const fence = new MetaWriteFence(() => now)
  return { fence, advanceTo: (t: number) => (now = t) }
}

describe('MetaWriteFence', () => {
  it('is pending while the write is in flight, for any fetch', () => {
    const { fence } = fenceAt(1000)
    fence.begin('w', 'local')
    expect(fence.isPending('w', 'local')).toBe(true)
    expect(fence.isPending('w', 'local', 5000)).toBe(true)
  })

  // Regression: releasing the moment the write settled let a fetch that had started after the
  // assignment but joined an older listing merge its stale answer once the write was done.
  it('stays armed after release for a fetch that started before the write landed', () => {
    const { fence, advanceTo } = fenceAt(1000)
    const { landed } = fence.begin('w', 'local')
    advanceTo(2000)
    landed()
    expect(fence.isPending('w', 'local', 1500)).toBe(true)
    expect(fence.isPending('w', 'local', 2000)).toBe(true)
  })

  it('stands down for a fetch that started after the write landed', () => {
    const { fence, advanceTo } = fenceAt(1000)
    const { landed } = fence.begin('w', 'local')
    advanceTo(2000)
    landed()
    expect(fence.isPending('w', 'local', 2001)).toBe(false)
  })

  it('is not pending after release for a caller with no listing context', () => {
    const { fence } = fenceAt(1000)
    fence.begin('w', 'local').landed()
    expect(fence.isPending('w', 'local')).toBe(false)
  })

  // Regression: a rejected write was recorded as landed, so the recovery fetch that follows a
  // failure — starting within the same millisecond — was fenced out and the failed optimistic
  // color stayed on the card with no later refresh to revert it.
  it('drops a failed write so the recovery fetch can revert the optimistic value', () => {
    const { fence } = fenceAt(1000)
    fence.begin('w', 'local').failed()
    expect(fence.isPending('w', 'local')).toBe(false)
    expect(fence.isPending('w', 'local', 1000)).toBe(false)
    expect(fence.isPending('w', 'local', 0)).toBe(false)
  })

  // Regression: HUB A and HUB B expose rows with the same id and physical host; a write for A's
  // row fenced B's refresh and replaced B's fresh tag with its stale local value.
  it('does not let a write for one HUB row fence a refresh of the sibling row', () => {
    const { fence } = fenceAt(1000)
    fence.begin('w', 'ssh:box', 'k-a')
    expect(fence.isPending('w', 'ssh:box', undefined, 'k-a')).toBe(true)
    expect(fence.isPending('w', 'ssh:box', undefined, 'k-b')).toBe(false)
  })

  it('falls back to id and host when either side has no identity', () => {
    const { fence } = fenceAt(1000)
    fence.begin('w', 'ssh:box', 'k-a')
    expect(fence.isPending('w', 'ssh:box')).toBe(true)
    const { fence: legacy } = fenceAt(1000)
    legacy.begin('w', 'ssh:box')
    expect(legacy.isPending('w', 'ssh:box', undefined, 'k-b')).toBe(true)
  })

  // Regression: before a nested-SSH row has an identity, HUB A and HUB B expose it as rows sharing
  // id and host that differ only by runtime owner; a write for A's row fenced B's refresh.
  it('does not let a write for one runtime owner fence a refresh of the sibling owner', () => {
    const { fence } = fenceAt(1000)
    fence.begin('w', 'ssh:box', undefined, 'env-a')
    expect(fence.isPending('w', 'ssh:box', undefined, undefined, 'env-a')).toBe(true)
    expect(fence.isPending('w', 'ssh:box', undefined, undefined, 'env-b')).toBe(false)
  })

  // Regression: the desktop lists a checkout directly while a HUB also publishes it as an
  // identity-less sibling; the direct write's fence matched the HUB listing on id and host.
  it("keeps a direct row's write apart from an identity-less HUB sibling's listing", () => {
    const { fence } = fenceAt(1000)
    fence.begin('w', 'ssh:box', undefined, null)
    expect(fence.isPending('w', 'ssh:box', undefined, undefined, 'env-hub')).toBe(false)
    expect(fence.isPending('w', 'ssh:box', undefined, undefined, null)).toBe(true)
    expect(fence.isPending('w', 'ssh:box')).toBe(true)
  })

  it('falls back to id and host when either side has no runtime owner', () => {
    const { fence } = fenceAt(1000)
    fence.begin('w', 'ssh:box', undefined, 'env-a')
    expect(fence.isPending('w', 'ssh:box')).toBe(true)
    const { fence: legacy } = fenceAt(1000)
    legacy.begin('w', 'ssh:box')
    expect(legacy.isPending('w', 'ssh:box', undefined, undefined, 'env-b')).toBe(true)
  })

  // Regression: a write that began under the pre-rename id could not fence a stale refresh merged
  // under the new id, although both sides carried the same identity.
  it('matches a renamed row by identity even though the id has changed', () => {
    const { fence } = fenceAt(1000)
    fence.begin('repo::/before', 'local', 'k-same')
    expect(fence.isPending('repo::/after', 'local', undefined, 'k-same')).toBe(true)
    expect(fence.isPending('repo::/after', 'local', undefined, 'k-other')).toBe(false)
    expect(fence.isPending('repo::/after', 'local')).toBe(false)
  })

  // Regression: a listing that started before the write landed but already carried the written
  // value was held as stale, so the host's own confirmation of the write was thrown away.
  it('does not hold a listing that already shows the written value', () => {
    const { fence } = fenceAt(1000)
    fence.begin('w', 'local', undefined, undefined, { written: '#ef4444' })
    expect(fence.isPending('w', 'local', undefined, undefined, undefined, '#ef4444')).toBe(false)
    expect(fence.isPending('w', 'local', undefined, undefined, undefined, null)).toBe(true)
  })

  // Regression: a peer could change the tag after this write reached the host and before its
  // response settled; the fetch that change produced started before release, was held, and nothing
  // ever asked the host again.
  it('asks for one reconcile after landing when it held a listing while in flight', async () => {
    const onHeldListing = vi.fn()
    const { fence } = fenceAt(1000)
    const { landed } = fence.begin('w', 'local', undefined, undefined, { onHeldListing })
    fence.isPending('w', 'local', 900)
    fence.isPending('w', 'local', 950)
    await Promise.resolve()
    expect(onHeldListing).not.toHaveBeenCalled()
    landed()
    await Promise.resolve()
    expect(onHeldListing).toHaveBeenCalledTimes(1)
  })

  it('reconciles once, deferred, when a released fence holds a late listing', async () => {
    const onHeldListing = vi.fn()
    const { fence, advanceTo } = fenceAt(1000)
    const { landed } = fence.begin('w', 'local', undefined, undefined, { onHeldListing })
    advanceTo(2000)
    landed()
    await Promise.resolve()
    expect(onHeldListing).not.toHaveBeenCalled()
    expect(fence.isPending('w', 'local', 1500)).toBe(true)
    expect(onHeldListing).not.toHaveBeenCalled()
    expect(fence.isPending('w', 'local', 1600)).toBe(true)
    await Promise.resolve()
    expect(onHeldListing).toHaveBeenCalledTimes(1)
  })

  // Regression: the reconcile read scheduled from landing started in the same millisecond as the
  // release, matched `fetchStartedAt <= releasedAt`, and was held as stale; with the one-shot spent,
  // the peer's newer color never landed.
  it('never holds a read that started at or after its own reconcile request', async () => {
    const onHeldListing = vi.fn()
    const { fence } = fenceAt(1000)
    const { landed } = fence.begin('w', 'local', undefined, undefined, { onHeldListing })
    fence.isPending('w', 'local', 900)
    landed()
    await Promise.resolve()
    expect(onHeldListing).toHaveBeenCalledTimes(1)
    expect(fence.isPending('w', 'local', 1000)).toBe(false)
    expect(fence.isPending('w', 'local', 999)).toBe(true)
    await Promise.resolve()
    expect(onHeldListing).toHaveBeenCalledTimes(1)
  })

  it('never reconciles for a write that held nothing, or one that failed', async () => {
    const onHeldListing = vi.fn()
    const { fence } = fenceAt(1000)
    fence.begin('w', 'local', undefined, undefined, { onHeldListing }).landed()
    const failing = fence.begin('x', 'local', undefined, undefined, { onHeldListing })
    fence.isPending('x', 'local')
    failing.failed()
    await Promise.resolve()
    expect(onHeldListing).not.toHaveBeenCalled()
  })

  // Regression: clear() dropped the entry, but a late landed() still saw it held and queued its
  // refresh into whatever test ran next.
  it('ignores a late landing after clear', async () => {
    const onHeldListing = vi.fn()
    const { fence } = fenceAt(1000)
    const { landed } = fence.begin('w', 'local', undefined, undefined, { onHeldListing })
    fence.isPending('w', 'local', 900)
    fence.clear()
    landed()
    await Promise.resolve()
    expect(onHeldListing).not.toHaveBeenCalled()
    expect(fence.isPending('w', 'local', 900)).toBe(false)
  })

  it('clear drops every entry', () => {
    const { fence } = fenceAt(1000)
    fence.begin('w', 'local').landed()
    fence.begin('x', 'local')
    fence.clear()
    expect(fence.isPending('w', 'local', 500)).toBe(false)
    expect(fence.isPending('x', 'local')).toBe(false)
  })

  it('matches a host-agnostic query against a host-scoped entry and vice versa', () => {
    const { fence } = fenceAt(1000)
    fence.begin('w', 'ssh:box')
    expect(fence.isPending('w')).toBe(true)
    expect(fence.isPending('w', 'ssh:other')).toBe(false)
    expect(fence.isPending('other', 'ssh:box')).toBe(false)
  })

  // Why 120 s: a stale refresh can stay mergeable through a 30 s listing budget plus up to 30 s of
  // terminal teardown; a shorter window pruned the only guard while such a merge was still pending.
  it('keeps a released entry through the whole listing-plus-teardown pipeline', () => {
    const { fence, advanceTo } = fenceAt(1000)
    fence.begin('w', 'local').landed()
    advanceTo(1000 + 60_000)
    expect(fence.isPending('w', 'local', 0)).toBe(true)
  })

  it('forgets released entries once no live refresh could still merge', () => {
    const { fence, advanceTo } = fenceAt(1000)
    fence.begin('w', 'local').landed()
    advanceTo(1000 + 120_000 + 1)
    expect(fence.isPending('w', 'local', 0)).toBe(false)
  })
})
