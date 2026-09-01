import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RepoRefMaintenance } from './repo-ref-maintenance'
import {
  REF_MAINTENANCE_ATTEMPT_DEADLINE_MS,
  REF_MAINTENANCE_PACKED_COOLDOWN_MS,
  type RefMaintenanceSpan,
  type RepoRefMaintenanceOptions,
  type RepoRefMaintenanceTarget
} from './repo-ref-maintenance-policy'

const QUIET_MS = 1000
const THRESHOLD = 5
const roots: string[] = []

async function refsDirectoryWith(looseRefs: number): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-ref-maintenance-'))
  roots.push(root)
  const refs = join(root, 'refs', 'remotes', 'origin')
  await mkdir(refs, { recursive: true })
  for (let index = 0; index < looseRefs; index += 1) {
    await writeFile(join(refs, `ref-${index}`), 'a')
  }
  return join(root, 'refs')
}

/** More directories than `countLooseRefs` will visit, but very few files. */
async function saturatingRefsDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-ref-maintenance-wide-'))
  roots.push(root)
  const refs = join(root, 'refs')
  for (let index = 0; index < 4200; index += 1) {
    await mkdir(join(refs, `ns-${index}`), { recursive: true })
  }
  return refs
}

/** Stands in for a pack that moved the refs into packed-refs before erroring. */
async function emptyRefsDirectory(refs: string): Promise<void> {
  await rm(refs, { recursive: true, force: true })
}

function attributesOf(span: RefMaintenanceSpan): Record<string, unknown> {
  return (span as unknown as { recorded: Record<string, unknown> }).recorded
}

function recordingSpan(): RefMaintenanceSpan {
  const recorded: Record<string, unknown> = {}
  return {
    recorded,
    setAttribute(key: string, value: unknown) {
      recorded[key] = value
    }
  } as unknown as RefMaintenanceSpan
}

type Harness = {
  maintenance: RepoRefMaintenance
  spans: RefMaintenanceSpan[]
  packRefs: ((signal: AbortSignal) => Promise<void>) & { mock: { calls: unknown[] } }
}

function createHarness(
  overrides: Partial<RepoRefMaintenanceOptions> & {
    packRefs?: (signal: AbortSignal) => Promise<void>
  } = {}
): Harness {
  const spans: RefMaintenanceSpan[] = []
  const packRefs = vi.fn<(signal: AbortSignal) => Promise<void>>(
    overrides.packRefs ?? (async () => {})
  )
  const maintenance = new RepoRefMaintenance({
    quietPeriodMs: QUIET_MS,
    looseRefThreshold: THRESHOLD,
    now: () => Date.now(),
    observe: (attempt) => {
      const span = recordingSpan()
      spans.push(span)
      return attempt(span)
    },
    ...overrides
  })
  return { maintenance, spans, packRefs }
}

function target(
  key: string,
  refsDirectory: string,
  packRefs: (signal: AbortSignal) => Promise<void>,
  extra: Partial<RepoRefMaintenanceTarget> = {}
): RepoRefMaintenanceTarget {
  return {
    key,
    resolveRefsDirectory: async () => refsDirectory,
    packRefs,
    ...extra
  }
}

/** Resolves the first time the pack starts, so tests never race real filesystem I/O. */
function packStartSignal(): { started: Promise<AbortSignal>; onStart: (s: AbortSignal) => void } {
  let onStart: (s: AbortSignal) => void = () => {}
  const started = new Promise<AbortSignal>((resolve) => {
    onStart = resolve
  })
  return { started, onStart }
}

function yieldToIo(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve))
}

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !predicate(); attempt += 1) {
    await yieldToIo()
  }
}

/** Fires the quiet-period timer and waits for the attempt it starts. */
async function elapseQuietPeriod(maintenance: RepoRefMaintenance, periods = 1): Promise<void> {
  await vi.advanceTimersByTimeAsync(QUIET_MS * periods)
  await maintenance.whenAttemptSettled()
}

/** Only the quiet-period timer is faked; real filesystem I/O still has to complete. */
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
})

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('RepoRefMaintenance gating', () => {
  it('packs only after the repo has been quiet for the full period', async () => {
    const refs = await refsDirectoryWith(THRESHOLD + 2)
    const { maintenance, spans, packRefs } = createHarness()
    const repo = target('local::/repo/.git', refs, packRefs)

    maintenance.arm(repo)
    await vi.advanceTimersByTimeAsync(QUIET_MS - 1)
    expect(packRefs).not.toHaveBeenCalled()

    // A second write restarts the countdown rather than shortening it.
    maintenance.arm(repo)
    await vi.advanceTimersByTimeAsync(QUIET_MS - 1)
    expect(packRefs).not.toHaveBeenCalled()

    await elapseQuietPeriod(maintenance)
    expect(packRefs).toHaveBeenCalledTimes(1)
    expect(attributesOf(spans[0])).toMatchObject({
      'repo.maintenance_outcome': 'packed',
      'repo.maintenance_key': 'local::/repo/.git',
      'git.loose_ref_count': THRESHOLD + 1
    })
  })

  it('leaves a healthy repository alone', async () => {
    const refs = await refsDirectoryWith(THRESHOLD - 1)
    const { maintenance, spans, packRefs } = createHarness()

    maintenance.arm(target('local::/healthy/.git', refs, packRefs))
    await elapseQuietPeriod(maintenance)

    expect(packRefs).not.toHaveBeenCalled()
    expect(attributesOf(spans[0])).toMatchObject({
      'repo.maintenance_outcome': 'below_threshold',
      'git.loose_ref_count': THRESHOLD - 1
    })
  })

  it('does not run while the app is busy', async () => {
    const refs = await refsDirectoryWith(THRESHOLD + 2)
    let busy = true
    const { maintenance, packRefs } = createHarness({ isBusy: () => busy })

    maintenance.arm(target('local::/busy/.git', refs, packRefs))
    await elapseQuietPeriod(maintenance)
    expect(packRefs).not.toHaveBeenCalled()

    // The deferral re-arms on a backed-off delay, so the next window picks it up.
    busy = false
    await elapseQuietPeriod(maintenance, 2)
    expect(packRefs).toHaveBeenCalledTimes(1)
  })

  it('does not run while the repo itself has work in flight', async () => {
    const refs = await refsDirectoryWith(THRESHOLD + 2)
    const { maintenance, packRefs } = createHarness()

    maintenance.arm(target('local::/fetching/.git', refs, packRefs, { isBusy: () => true }))
    await elapseQuietPeriod(maintenance)

    expect(packRefs).not.toHaveBeenCalled()
  })

  it('honours a user who disabled Git auto-maintenance for the repo', async () => {
    const refs = await refsDirectoryWith(THRESHOLD + 2)
    const { maintenance, spans, packRefs } = createHarness()

    maintenance.arm(
      target('local::/opted-out/.git', refs, packRefs, { isOptedOut: async () => true })
    )
    await elapseQuietPeriod(maintenance)

    expect(packRefs).not.toHaveBeenCalled()
    expect(attributesOf(spans[0])['repo.maintenance_outcome']).toBe('opted_out')
  })

  it('never reads a truncated walk as a clean repository', async () => {
    const { maintenance, spans, packRefs } = createHarness()

    // A walk that stopped early reports a floor, so a low count is not evidence of health.
    maintenance.arm({
      key: 'local::/saturated/.git',
      resolveRefsDirectory: async () => saturatingRefsDirectory(),
      packRefs
    })
    await elapseQuietPeriod(maintenance)

    expect(packRefs).toHaveBeenCalledTimes(1)
    expect(attributesOf(spans[0])['repo.maintenance_outcome']).toBe('packed')
  })

  it('aborts an attempt that outlives the deadline rather than abandoning it', async () => {
    const refs = await refsDirectoryWith(THRESHOLD + 2)
    const { started, onStart } = packStartSignal()
    const { maintenance, spans } = createHarness()

    maintenance.arm(
      target('local::/stuck/.git', refs, async (signal) => {
        onStart(signal)
        // A killed git child rejects; only an abort ends this one, same as the real thing.
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason as Error))
        })
      })
    )
    await vi.advanceTimersByTimeAsync(QUIET_MS)
    const observed = await started
    await vi.advanceTimersByTimeAsync(REF_MAINTENANCE_ATTEMPT_DEADLINE_MS)
    await maintenance.whenAttemptSettled()

    expect(observed.aborted).toBe(true)
    // A stall is not a yield: back off rather than retrying straight into it.
    expect(attributesOf(spans[0])['repo.maintenance_outcome']).toBe('timed_out')
  })

  it('skips a repository whose common dir cannot be resolved', async () => {
    const { maintenance, spans, packRefs } = createHarness()

    maintenance.arm({
      key: 'local::/gone/.git',
      resolveRefsDirectory: async () => undefined,
      packRefs
    })
    await elapseQuietPeriod(maintenance)

    expect(packRefs).not.toHaveBeenCalled()
    expect(attributesOf(spans[0])['repo.maintenance_outcome']).toBe('unresolved')
  })
})

describe('RepoRefMaintenance single-flight and backoff', () => {
  it('runs one repository at a time', async () => {
    const refs = await refsDirectoryWith(THRESHOLD + 2)
    let concurrent = 0
    let peak = 0
    const releases: (() => void)[] = []
    const { maintenance } = createHarness()
    const slowPack = async (): Promise<void> => {
      concurrent += 1
      peak = Math.max(peak, concurrent)
      await new Promise<void>((resolve) => releases.push(resolve))
      concurrent -= 1
    }

    maintenance.arm(target('local::/a/.git', refs, slowPack))
    maintenance.arm(target('local::/b/.git', refs, slowPack))
    await vi.advanceTimersByTimeAsync(QUIET_MS)
    await until(() => concurrent === 1)
    expect(concurrent).toBe(1)

    releases.shift()?.()
    await maintenance.whenAttemptSettled()
    // The second repo was deferred, so its retry waits a backed-off delay.
    await vi.advanceTimersByTimeAsync(QUIET_MS * 2)
    await until(() => concurrent === 1)
    releases.shift()?.()
    await maintenance.whenAttemptSettled()

    expect(peak).toBe(1)
    expect(concurrent).toBe(0)
  })

  it('stops a running pack for work that is about to touch refs, and retries it', async () => {
    const refs = await refsDirectoryWith(THRESHOLD + 2)
    let started = 0
    const first = packStartSignal()
    const { maintenance, spans } = createHarness()
    const repo = target('local::/yield/.git', refs, async (signal) => {
      started += 1
      first.onStart(signal)
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason as Error))
      })
    })

    maintenance.arm(repo)
    await vi.advanceTimersByTimeAsync(QUIET_MS)
    const observed = await first.started

    const release = await maintenance.pause('worktree-remove')

    // pause() only resolves once the pack has really stopped, so the caller's
    // ref deletion never races `packed-refs.lock`.
    expect(observed.aborted).toBe(true)
    expect(attributesOf(spans[0])['repo.maintenance_outcome']).toBe('interrupted')

    // Nothing may start again while the caller holds the window open.
    await vi.advanceTimersByTimeAsync(QUIET_MS * 8)
    expect(started).toBe(1)

    // An interrupt is not a failure: releasing lets the retry through.
    release()
    await vi.advanceTimersByTimeAsync(QUIET_MS * 8)
    await until(() => started === 2)
    expect(started).toBe(2)
  })

  it('reopens the window only when the last overlapping caller releases', async () => {
    const refs = await refsDirectoryWith(THRESHOLD + 2)
    const { maintenance, packRefs } = createHarness()

    const outer = await maintenance.pause('worktree-add')
    const inner = await maintenance.pause('git-fetch')
    maintenance.arm(target('local::/nested/.git', refs, packRefs))

    await elapseQuietPeriod(maintenance, 8)
    expect(packRefs).not.toHaveBeenCalled()

    inner()
    await elapseQuietPeriod(maintenance, 8)
    expect(packRefs).not.toHaveBeenCalled()

    outer()
    await elapseQuietPeriod(maintenance, 8)
    expect(packRefs).toHaveBeenCalledTimes(1)
  })

  it('restarts every armed countdown when the user does ref work themselves', async () => {
    const refs = await refsDirectoryWith(THRESHOLD + 2)
    const { maintenance, packRefs } = createHarness()

    maintenance.arm(target('local::/a/.git', refs, packRefs))
    maintenance.arm(target('local::/b/.git', refs, packRefs))
    await vi.advanceTimersByTimeAsync(QUIET_MS - 1)

    // A manual fetch says the user is at the keyboard, so nothing may fire yet.
    maintenance.postponeAll()
    await vi.advanceTimersByTimeAsync(QUIET_MS - 1)
    expect(packRefs).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(QUIET_MS)
    await until(() => packRefs.mock.calls.length > 0)
    expect(packRefs).toHaveBeenCalled()
  })

  it('costs nothing when no pack is running', async () => {
    const { maintenance } = createHarness()

    const release = await maintenance.pause('git-fetch')
    release()
    // Releasing twice must not leave the window wedged shut.
    release()
    const refs = await refsDirectoryWith(THRESHOLD + 2)
    const { packRefs } = createHarness()
    maintenance.arm(target('local::/free/.git', refs, packRefs))
    await elapseQuietPeriod(maintenance)

    expect(packRefs).toHaveBeenCalledTimes(1)
  })

  it('does not re-pack a repository inside its cooldown', async () => {
    const refs = await refsDirectoryWith(THRESHOLD + 2)
    let clock = 0
    const { maintenance, packRefs } = createHarness({ now: () => clock })
    const repo = target('local::/cooldown/.git', refs, packRefs)

    maintenance.arm(repo)
    await elapseQuietPeriod(maintenance)
    expect(packRefs).toHaveBeenCalledTimes(1)

    clock = REF_MAINTENANCE_PACKED_COOLDOWN_MS - 1
    maintenance.arm(repo)
    await elapseQuietPeriod(maintenance)
    expect(packRefs).toHaveBeenCalledTimes(1)

    clock = REF_MAINTENANCE_PACKED_COOLDOWN_MS + 1
    maintenance.arm(repo)
    await elapseQuietPeriod(maintenance)
    expect(packRefs).toHaveBeenCalledTimes(2)
  })

  it('counts a pack that could not lock every ref as a success', async () => {
    // Field-observed on a machine running several Orca sessions: a branch moved
    // mid-pack, Git reported an error, and 36,688 loose refs still became 3.
    // Retrying that aggressively would be wrong -- the backlog is gone.
    const refs = await refsDirectoryWith(THRESHOLD + 2)
    const { maintenance, spans } = createHarness()
    const repo = target('local::/raced/.git', refs, async () => {
      await emptyRefsDirectory(refs)
      throw new Error("error: cannot lock ref 'refs/heads/moved'")
    })

    maintenance.arm(repo)
    await elapseQuietPeriod(maintenance)

    expect(attributesOf(spans[0])).toMatchObject({
      'repo.maintenance_outcome': 'packed',
      'git.pack_refs_partial': true,
      'git.loose_ref_count_after': 0
    })

    // And it serves the full post-pack cooldown rather than retrying.
    maintenance.arm(repo)
    await elapseQuietPeriod(maintenance)
    expect(spans).toHaveLength(1)
  })

  it('records a failure when the pack left the backlog in place', async () => {
    const refs = await refsDirectoryWith(THRESHOLD + 2)
    const { maintenance, spans } = createHarness({
      packRefs: async () => {
        throw new Error('permission denied')
      }
    })

    maintenance.arm(target('local::/denied/.git', refs, () => Promise.reject(new Error('denied'))))
    await elapseQuietPeriod(maintenance)

    expect(attributesOf(spans[0])['repo.maintenance_outcome']).toBe('failed')
  })

  it('records a failure instead of throwing, and backs off', async () => {
    const refs = await refsDirectoryWith(THRESHOLD + 2)
    const { maintenance, spans, packRefs } = createHarness({
      packRefs: async () => {
        throw new Error('packed-refs.lock exists')
      }
    })
    const repo = target('local::/failing/.git', refs, packRefs)

    maintenance.arm(repo)
    await elapseQuietPeriod(maintenance)
    expect(attributesOf(spans[0])['repo.maintenance_outcome']).toBe('failed')

    maintenance.arm(repo)
    await elapseQuietPeriod(maintenance)
    expect(packRefs).toHaveBeenCalledTimes(1)
  })

  it('stops scheduling once disposed', async () => {
    const refs = await refsDirectoryWith(THRESHOLD + 2)
    const { maintenance, packRefs } = createHarness()

    maintenance.arm(target('local::/disposed/.git', refs, packRefs))
    maintenance.dispose()
    await elapseQuietPeriod(maintenance)

    expect(packRefs).not.toHaveBeenCalled()
  })
})
