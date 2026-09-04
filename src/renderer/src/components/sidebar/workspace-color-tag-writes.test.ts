import { describe, expect, it, vi } from 'vitest'
import type { Worktree } from '../../../../shared/worktree/types'
import {
  assignWorkspaceColorTags,
  type WorkspaceColorTagWriter
} from './workspace-color-tag-writes'
import { readWorkspaceColorTagPreview } from './workspace-color-tag-preview'

// Why unique ids per test: the coordinator's queues are module-level on purpose (they must span
// every menu instance), so a write one test leaves in flight would stall a later test that
// reused the same identity.
function worktree(id: string, hostId?: string): Worktree {
  return { id, hostId } as unknown as Worktree
}

/** A writer whose promises the test settles by hand, in call order. */
function deferredWriter() {
  const resolvers: (() => void)[] = []
  const write = vi.fn<WorkspaceColorTagWriter>(
    () =>
      new Promise((resolve) => {
        resolvers.push(() => resolve({ ok: true }))
      })
  )
  return {
    write,
    settleNext: () => resolvers.shift()?.(),
    settleAt: (index: number) => resolvers.splice(index, 1)[0]?.(),
    settleAll: () => {
      for (const resolve of resolvers.splice(0)) {
        resolve()
      }
    }
  }
}

// Why a macrotask: the landing promise sits several `.then`s deep (write -> result -> settle ->
// Promise.all -> caller), so a fixed count of awaits is brittle; a timer tick drains them all.
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('assignWorkspaceColorTags', () => {
  // Regression: every card mounted its own queue, so A's menu and B's menu wrote the same
  // workspace concurrently and whichever settled last won.
  it('serializes writes to one workspace no matter which caller issued them', async () => {
    const { write, settleNext, settleAll } = deferredWriter()
    const a = worktree('serial::a')

    void assignWorkspaceColorTags([a], '#111111', write, vi.fn())
    void assignWorkspaceColorTags([a], '#222222', write, vi.fn())
    expect(write).toHaveBeenCalledTimes(1)

    settleNext()
    await flush()
    expect(write.mock.calls.map((call) => call[1])).toEqual([
      { colorTag: '#111111' },
      { colorTag: '#222222' }
    ])
    settleAll()
  })

  it('keeps the newest color per workspace when later selections overlap earlier ones', async () => {
    const { write, settleNext, settleAll } = deferredWriter()
    const [a, b, c] = [worktree('overlap::a'), worktree('overlap::b'), worktree('overlap::c')]

    void assignWorkspaceColorTags([a], '#111111', write, vi.fn())
    void assignWorkspaceColorTags([a, b], '#0000ff', write, vi.fn())
    void assignWorkspaceColorTags([a, c], '#00ff00', write, vi.fn())
    // b and c had nothing in flight, so theirs went out immediately; a is queued behind #111111.
    settleNext()
    await flush()

    const byId = new Map(write.mock.calls.map((call) => [call[0], call[1].colorTag]))
    expect(byId.get('overlap::a')).toBe('#00ff00')
    expect(byId.get('overlap::b')).toBe('#0000ff')
    expect(byId.get('overlap::c')).toBe('#00ff00')
    expect(write.mock.calls.filter((call) => call[0] === 'overlap::a')).toHaveLength(2)
    settleAll()
  })

  it('treats the same worktree id on two hosts as two independent queues', () => {
    const { write, settleAll } = deferredWriter()
    void assignWorkspaceColorTags(
      [worktree('hosts::a', 'ssh-box'), worktree('hosts::a')],
      '#111111',
      write,
      vi.fn()
    )
    expect(write).toHaveBeenCalledTimes(2)
    expect(write.mock.calls.map((call) => call[2]?.executionHostId).sort()).toEqual([
      'local',
      'ssh-box'
    ])
    settleAll()
  })

  it('keeps two runtime-scoped rows for one worktree in separate queues', () => {
    const { write, settleAll } = deferredWriter()
    const viaRuntimeA = {
      id: 'nested::w',
      hostId: 'ssh:box',
      identity: { key: 'k-a' }
    } as unknown as Worktree
    const viaRuntimeB = {
      id: 'nested::w',
      hostId: 'ssh:box',
      identity: { key: 'k-b' }
    } as unknown as Worktree
    void assignWorkspaceColorTags([viaRuntimeA, viaRuntimeB], '#111111', write, vi.fn())
    expect(write).toHaveBeenCalledTimes(2)
    // Why: keying the queue by identity is not enough — the write itself must pin that row.
    expect(write.mock.calls.map((call) => call[2]?.identityKey).sort()).toEqual(['k-a', 'k-b'])
    settleAll()
  })

  // Regression: a refresh promoted an identity-less row to its canonical identity while its first
  // write was in flight; the next assignment opened a second queue and two RPCs raced.
  it('keeps one queue when a row gains its identity mid-flight', async () => {
    const { write, settleNext, settleAll } = deferredWriter()
    const detected = {
      id: 'promo::w',
      hostId: 'ssh:box',
      runtimeOwnerEnvironmentId: 'env-p'
    } as unknown as Worktree
    const promoted = { ...detected, identity: { key: 'k-promo' } } as unknown as Worktree
    void assignWorkspaceColorTags([detected], '#111111', write, vi.fn())
    void assignWorkspaceColorTags([promoted], '#222222', write, vi.fn())
    expect(write).toHaveBeenCalledTimes(1)
    settleNext()
    await flush()
    expect(write).toHaveBeenCalledTimes(2)
    expect(write.mock.calls[1]?.[2]).toMatchObject({ identityKey: 'k-promo' })
    settleAll()
  })

  // Regression: the queued write took its pin from the stale copy and sent no identity, so a
  // checkout replaced at the same path before it started could receive the color.
  it('pins a write queued from a not-yet-refreshed card with the identity the queue learned', async () => {
    const { write, settleNext, settleAll } = deferredWriter()
    const promoted = {
      id: 'promo::r',
      hostId: 'ssh:box',
      identity: { key: 'k-r' },
      runtimeOwnerEnvironmentId: 'env-r'
    } as unknown as Worktree
    // A copy that has not refreshed lacks the identity, not the owner its listing came with.
    const stale = {
      id: 'promo::r',
      hostId: 'ssh:box',
      runtimeOwnerEnvironmentId: 'env-r'
    } as unknown as Worktree
    void assignWorkspaceColorTags([promoted], '#111111', write, vi.fn())
    void assignWorkspaceColorTags([stale], '#222222', write, vi.fn())
    expect(write).toHaveBeenCalledTimes(1)

    settleNext()
    await flush()
    expect(write).toHaveBeenCalledTimes(2)
    expect(write.mock.calls[1]?.[2]).toMatchObject({
      identityKey: 'k-r',
      runtimeOwnerEnvironmentId: 'env-r'
    })
    settleAll()
  })

  // Regression: an identity-less detected-only nested-SSH row lost its runtime owner on the way to
  // the store, so owner resolution could not tell it from a sibling exposed by another HUB.
  it('carries the runtime owner for rows that have no canonical identity yet', () => {
    const { write, settleAll } = deferredWriter()
    const viaHub = {
      id: 'nested::d',
      hostId: 'ssh:box',
      runtimeOwnerEnvironmentId: 'env-hub'
    } as unknown as Worktree
    void assignWorkspaceColorTags([viaHub], '#111111', write, vi.fn())
    expect(write.mock.calls[0]?.[2]).toMatchObject({
      executionHostId: 'ssh:box',
      runtimeOwnerEnvironmentId: 'env-hub'
    })
    settleAll()
  })

  // Regression: a preset on a folder workspace over a paired runtime changed nothing on screen until
  // the RPC returned, and reopening the menu computed the toggle from the stale store value.
  it('previews the pending color on the card until its queue drains', async () => {
    const { write, settleNext, settleAll } = deferredWriter()
    const folder = worktree('pending::folder', 'ssh:box')

    void assignWorkspaceColorTags([folder], '#111111', write, vi.fn())
    expect(readWorkspaceColorTagPreview(folder)).toBe('#111111')
    void assignWorkspaceColorTags([folder], null, write, vi.fn())
    // The newest pending value is what the card shows, a previewed clear included.
    expect(readWorkspaceColorTagPreview(folder)).toBeNull()

    settleNext()
    await flush()
    // The first write landed but the clear is still in flight: no flash of the old store value.
    expect(readWorkspaceColorTagPreview(folder)).toBeNull()
    settleAll()
    await flush()
    expect(readWorkspaceColorTagPreview(folder)).toBeUndefined()
  })

  // Regression: the pending preview sat under the promoted row's canonical key only, so a copy of the
  // row that had not refreshed yet, reading under its pre-identity key, showed the old strip.
  it('previews a pending color for copies of the row that still lack its identity', async () => {
    const { write, settleAll } = deferredWriter()
    const promoted = {
      id: 'alias::w',
      hostId: 'ssh:box',
      identity: { key: 'k-alias' }
    } as unknown as Worktree
    const stale = { id: 'alias::w', hostId: 'ssh:box' } as unknown as Worktree

    void assignWorkspaceColorTags([promoted], '#111111', write, vi.fn())
    expect(readWorkspaceColorTagPreview(stale)).toBe('#111111')

    settleAll()
    await flush()
    expect(readWorkspaceColorTagPreview(stale)).toBeUndefined()
    expect(readWorkspaceColorTagPreview(promoted)).toBeUndefined()
  })

  // Regression: every queue previewed under one shared owner, so when a checkout was replaced while
  // its predecessor's write was pending, the predecessor's drain cleared the successor's pending
  // preview and an identity-less copy lost the strip before the new write landed.
  it("keeps the successor occupant's pending preview when the predecessor's queue drains", async () => {
    const { write, settleNext, settleAll } = deferredWriter()
    const old = {
      id: 'repl::w',
      hostId: 'ssh:box',
      identity: { key: 'k-old' }
    } as unknown as Worktree
    const replacement = { ...old, identity: { key: 'k-new' } } as unknown as Worktree
    const copy = { id: 'repl::w', hostId: 'ssh:box' } as unknown as Worktree

    void assignWorkspaceColorTags([old], '#111111', write, vi.fn())
    void assignWorkspaceColorTags([replacement], '#222222', write, vi.fn())
    expect(write).toHaveBeenCalledTimes(2)
    expect(readWorkspaceColorTagPreview(copy)).toBe('#222222')

    settleNext()
    await flush()
    expect(readWorkspaceColorTagPreview(copy)).toBe('#222222')
    settleAll()
    await flush()
    expect(readWorkspaceColorTagPreview(copy)).toBeUndefined()
  })

  // Regression: the fallback alias stayed bound to the predecessor's queue and died with it, so a
  // later write from a still identity-less copy opened a third concurrent queue and an older RPC
  // could land last.
  it('hands the fallback alias to the surviving occupant once the predecessor drains', async () => {
    const { write, settleNext, settleAll } = deferredWriter()
    const old = {
      id: 'repl::v',
      hostId: 'ssh:box',
      identity: { key: 'k-old2' }
    } as unknown as Worktree
    const replacement = { ...old, identity: { key: 'k-new2' } } as unknown as Worktree
    const copy = { id: 'repl::v', hostId: 'ssh:box' } as unknown as Worktree

    void assignWorkspaceColorTags([old], '#111111', write, vi.fn())
    void assignWorkspaceColorTags([replacement], '#222222', write, vi.fn())
    settleNext()
    await flush()

    void assignWorkspaceColorTags([copy], '#333333', write, vi.fn())
    expect(write).toHaveBeenCalledTimes(2)
    settleNext()
    await flush()
    expect(write).toHaveBeenCalledTimes(3)
    expect(write.mock.calls[2]?.[2]).toMatchObject({ identityKey: 'k-new2' })
    settleAll()
  })

  // Regression: the pre-identity alias stayed with the predecessor until it drained, so a copy of the
  // replacement that still lacked its identity joined the old queue and was pinned to the old row.
  it('joins an identity-less copy to the replacement occupant before the predecessor drains', async () => {
    const { write, settleNext, settleAll } = deferredWriter()
    const old = {
      id: 'repl::u',
      hostId: 'ssh:box',
      identity: { key: 'k-old3' }
    } as unknown as Worktree
    const replacement = { ...old, identity: { key: 'k-new3' } } as unknown as Worktree
    const copy = { id: 'repl::u', hostId: 'ssh:box' } as unknown as Worktree

    void assignWorkspaceColorTags([old], '#111111', write, vi.fn())
    void assignWorkspaceColorTags([replacement], '#222222', write, vi.fn())
    void assignWorkspaceColorTags([copy], '#333333', write, vi.fn())
    expect(write).toHaveBeenCalledTimes(2)

    settleNext()
    await flush()
    expect(write).toHaveBeenCalledTimes(2)
    settleNext()
    await flush()
    expect(write).toHaveBeenCalledTimes(3)
    expect(write.mock.calls[2]?.[2]).toMatchObject({ identityKey: 'k-new3' })
    settleAll()
  })

  // Regression: when the replacement's queue finished first, the drain handed the pre-identity alias
  // to the only survivor, the predecessor, and a later identity-less write was pinned to the old row.
  it('never hands the fallback alias back to an older occupant', async () => {
    const { write, settleAt, settleAll } = deferredWriter()
    const old = {
      id: 'repl::t',
      hostId: 'ssh:box',
      identity: { key: 'k-old4' }
    } as unknown as Worktree
    const replacement = { ...old, identity: { key: 'k-new4' } } as unknown as Worktree
    const copy = { id: 'repl::t', hostId: 'ssh:box' } as unknown as Worktree

    void assignWorkspaceColorTags([old], '#111111', write, vi.fn())
    void assignWorkspaceColorTags([replacement], '#222222', write, vi.fn())
    settleAt(1)
    await flush()

    void assignWorkspaceColorTags([copy], '#333333', write, vi.fn())
    expect(write).toHaveBeenCalledTimes(3)
    expect(write.mock.calls[2]?.[2]?.identityKey).toBeUndefined()
    settleAll()
  })

  // Regression: with three occupants of one path, the newest draining first and then the oldest let
  // the superseded intermediate reclaim the alias, and a later identity-less write was pinned to it.
  it('lets only the latest claimant take the fallback alias back', async () => {
    const { write, settleAt, settleAll } = deferredWriter()
    const first = {
      id: 'repl::s',
      hostId: 'ssh:box',
      identity: { key: 'k-a6' }
    } as unknown as Worktree
    const second = { ...first, identity: { key: 'k-b6' } } as unknown as Worktree
    const third = { ...first, identity: { key: 'k-c6' } } as unknown as Worktree
    const copy = { id: 'repl::s', hostId: 'ssh:box' } as unknown as Worktree

    void assignWorkspaceColorTags([first], '#111111', write, vi.fn())
    void assignWorkspaceColorTags([second], '#222222', write, vi.fn())
    void assignWorkspaceColorTags([third], '#333333', write, vi.fn())
    settleAt(2)
    await flush()
    settleAt(0)
    await flush()

    void assignWorkspaceColorTags([copy], '#444444', write, vi.fn())
    expect(write).toHaveBeenCalledTimes(4)
    expect(write.mock.calls[3]?.[2]?.identityKey).toBeUndefined()
    settleAll()
  })

  // Regression: the predecessor's pending preview leaked onto a checkout that replaced it at the
  // same path, because the fallback layer carried no notion of which occupant set it.
  it("keeps a predecessor's pending preview off a replacement row", () => {
    const { write, settleAll } = deferredWriter()
    const old = {
      id: 'repl::q',
      hostId: 'ssh:box',
      identity: { key: 'k-old7' }
    } as unknown as Worktree
    const replacement = { ...old, identity: { key: 'k-new7' } } as unknown as Worktree
    const copy = { id: 'repl::q', hostId: 'ssh:box' } as unknown as Worktree

    void assignWorkspaceColorTags([old], '#111111', write, vi.fn())
    expect(readWorkspaceColorTagPreview(old)).toBe('#111111')
    expect(readWorkspaceColorTagPreview(copy)).toBe('#111111')
    expect(readWorkspaceColorTagPreview(replacement)).toBeUndefined()
    settleAll()
  })

  // Regression: a newer color enqueued from a not-yet-refreshed copy previewed under the pre-identity
  // key only, so the canonical card kept the older color until the next write started.
  it('shows the newest pending color on every representation of the row', async () => {
    const { write, settleAll } = deferredWriter()
    const canonical = {
      id: 'dup::w',
      hostId: 'ssh:box',
      identity: { key: 'k-dup' },
      runtimeOwnerEnvironmentId: 'env-d'
    } as unknown as Worktree
    const copy = {
      id: 'dup::w',
      hostId: 'ssh:box',
      runtimeOwnerEnvironmentId: 'env-d'
    } as unknown as Worktree
    const replacement = { ...canonical, identity: { key: 'k-dup-2' } } as unknown as Worktree

    const first = assignWorkspaceColorTags([canonical], '#111111', write, vi.fn())
    const second = assignWorkspaceColorTags([copy], '#222222', write, vi.fn())
    expect(write).toHaveBeenCalledTimes(1)
    expect(readWorkspaceColorTagPreview(canonical)).toBe('#222222')
    expect(readWorkspaceColorTagPreview(copy)).toBe('#222222')
    expect(readWorkspaceColorTagPreview(replacement)).toBeUndefined()

    // Why settle both: the second write starts in a later continuation; leaving it pending would
    // let queue and preview state outlive this test.
    settleAll()
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(2))
    settleAll()
    await Promise.all([first, second])
    expect(readWorkspaceColorTagPreview(canonical)).toBeUndefined()
  })

  // Regression: a queue found by its canonical key kept the pre-rename row and never registered the
  // renamed row's pre-identity key, so a not-yet-promoted copy of the renamed row opened a second
  // queue and two RPCs raced.
  it('follows a rename so a copy of the renamed row joins the queue and is pinned to the new row', async () => {
    const { write, settleNext, settleAll } = deferredWriter()
    const before = {
      id: 'ren::before',
      hostId: 'ssh:box',
      identity: { key: 'k-ren' }
    } as unknown as Worktree
    const after = {
      id: 'ren::after',
      hostId: 'ssh:box',
      identity: { key: 'k-ren' }
    } as unknown as Worktree
    const copyOfAfter = { id: 'ren::after', hostId: 'ssh:box' } as unknown as Worktree

    void assignWorkspaceColorTags([before], '#111111', write, vi.fn())
    void assignWorkspaceColorTags([after], '#222222', write, vi.fn())
    void assignWorkspaceColorTags([copyOfAfter], '#333333', write, vi.fn())
    expect(write).toHaveBeenCalledTimes(1)

    settleNext()
    await flush()
    expect(write).toHaveBeenCalledTimes(2)
    expect(write.mock.calls[1]?.[0]).toBe('ren::after')
    expect(write.mock.calls[1]?.[1]).toEqual({ colorTag: '#333333' })
    expect(write.mock.calls[1]?.[2]).toMatchObject({ identityKey: 'k-ren' })
    settleAll()
  })

  // Regression: an identity-less direct-SSH row was written with no pin at all, so the reducers
  // recolored a HUB-proxied sibling too and the owner guess could persist through the HUB.
  it('pins a desktop-listed row with an explicit null owner', () => {
    const { write, settleAll } = deferredWriter()
    const direct = { id: 'direct::d', hostId: 'ssh:box' } as unknown as Worktree
    void assignWorkspaceColorTags([direct], '#111111', write, vi.fn())
    expect(write.mock.calls[0]?.[2]).toMatchObject({
      executionHostId: 'ssh:box',
      runtimeOwnerEnvironmentId: null
    })
    expect(write.mock.calls[0]?.[2]?.identityKey).toBeUndefined()
    settleAll()
  })

  // Regression: the picker dropped its preview the instant it closed, and a folder or queued write
  // only reaches the store when it lands, so the card snapped back for the whole round trip.
  it('resolves only after the write has landed', async () => {
    const { write, settleNext } = deferredWriter()
    let landed = false
    void assignWorkspaceColorTags([worktree('landing::a')], '#111111', write, vi.fn()).then(() => {
      landed = true
    })
    await flush()
    expect(landed).toBe(false)

    settleNext()
    await flush()
    expect(landed).toBe(true)
  })

  it('resolves a superseded assignment when the newer value lands', async () => {
    const { write, settleNext, settleAll } = deferredWriter()
    const a = worktree('supersede::a')
    let firstLanded = false
    void assignWorkspaceColorTags([a], '#111111', write, vi.fn()).then(() => {
      firstLanded = true
    })
    void assignWorkspaceColorTags([a], '#222222', write, vi.fn())
    void assignWorkspaceColorTags([a], '#333333', write, vi.fn())

    settleNext() // #111111 lands; #222222 was superseded by #333333 before it was ever written
    await flush()
    expect(firstLanded).toBe(true)
    expect(write.mock.calls.map((call) => call[1].colorTag)).toEqual(['#111111', '#333333'])
    settleAll()
  })

  it('reports a refused write once per assignment, not once per workspace', async () => {
    const write = vi.fn<WorkspaceColorTagWriter>().mockResolvedValue({
      ok: false,
      error: 'Update the remote runtime to set workspace colors'
    })
    const onError = vi.fn()
    await assignWorkspaceColorTags(
      [worktree('refused::a', 'ssh'), worktree('refused::b', 'ssh')],
      '#111111',
      write,
      onError
    )
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith('Update the remote runtime to set workspace colors')
  })

  it('keeps writing after a rejected write instead of wedging the queue', async () => {
    const write = vi
      .fn<WorkspaceColorTagWriter>()
      .mockRejectedValueOnce(new Error('host away'))
      .mockResolvedValue({ ok: true })
    const a = worktree('recover::a')
    await assignWorkspaceColorTags([a], '#111111', write, vi.fn())
    await assignWorkspaceColorTags([a], '#222222', write, vi.fn())
    expect(write.mock.calls.map((call) => call[1].colorTag)).toEqual(['#111111', '#222222'])
  })
})
