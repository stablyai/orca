import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RepoMaintenance } from './repo-maintenance'
import {
  PACKED_REFS_LOCK_WAIT_MS,
  REPO_MAINTENANCE_CLEAN_COOLDOWN_MS,
  REPO_MAINTENANCE_PACKED_COOLDOWN_MS,
  RepoMaintenanceRepoLocked,
  type PackedRefsLockReporter,
  type RepoMaintenanceBacklog,
  type RepoMaintenancePackReport,
  type RepoMaintenanceOptions,
  type RepoMaintenanceSpan,
  type RepoMaintenanceTarget,
  type RepoMaintenanceTask,
  type RepoMaintenanceTaskId
} from './repo-maintenance-policy'

const QUIET_MS = 1000
const REMAINDER_MS = 100
const THRESHOLD = 5

type RecordingSpan = RepoMaintenanceSpan & { readonly recorded: Record<string, unknown> }

function attributesOf(span: RecordingSpan): Record<string, unknown> {
  return span.recorded
}

function recordingSpan(): RecordingSpan {
  const recorded: Record<string, unknown> = {}
  return {
    recorded,
    setAttribute(key: string, value: unknown) {
      recorded[key] = value
    }
  }
}

type FakeTask = {
  task: RepoMaintenanceTask
  pack: ReturnType<typeof vi.fn>
  backlog: () => number
}

/**
 * A task with an in-memory backlog. The scheduler is deliberately blind to what
 * a backlog is, so nothing here needs a repository: what is under test is the
 * probe/threshold/pack/re-probe loop and the bookkeeping around it.
 */
function fakeTask(
  id: RepoMaintenanceTaskId,
  options: {
    backlog?: number
    threshold?: number
    /** Items one pack removes; the default clears the whole backlog. */
    batch?: number
    /** Force the probe to report a floor rather than a total. */
    saturated?: boolean
    /** The repository cannot be resolved on this host. */
    unresolved?: boolean
    window?: RepoMaintenanceTask['window']
    pack?: (lock: PackedRefsLockReporter, setBacklog: (count: number) => void) => Promise<void>
  } = {}
): FakeTask {
  const threshold = options.threshold ?? THRESHOLD
  let backlog = options.backlog ?? threshold
  const setBacklog = (count: number): void => {
    backlog = count
  }
  const batch = options.batch ?? Number.POSITIVE_INFINITY
  const pack = vi.fn(async (lock: PackedRefsLockReporter): Promise<RepoMaintenancePackReport> => {
    if (options.pack) {
      await options.pack(lock, setBacklog)
      return { batchExhausted: false }
    }
    const taken = Math.min(backlog, batch)
    backlog -= taken
    return { batchExhausted: taken >= batch }
  })
  return {
    pack,
    backlog: () => backlog,
    task: {
      id,
      threshold,
      ...(options.window ? { window: options.window } : {}),
      probeBacklog: async (budget: number): Promise<RepoMaintenanceBacklog | undefined> =>
        options.unresolved
          ? undefined
          : {
              count: Math.min(backlog, budget),
              saturated: options.saturated ?? backlog >= budget
            },
      pack
    }
  }
}

type Harness = {
  maintenance: RepoMaintenance
  spans: RecordingSpan[]
}

function createHarness(overrides: Partial<RepoMaintenanceOptions> = {}): Harness {
  const spans: RecordingSpan[] = []
  const maintenance = new RepoMaintenance({
    quietPeriodMs: QUIET_MS,
    remainderDelayMs: REMAINDER_MS,
    now: () => Date.now(),
    observe: (attempt) => {
      const span = recordingSpan()
      spans.push(span)
      return attempt(span)
    },
    ...overrides
  })
  return { maintenance, spans }
}

function target(
  key: string,
  tasks: FakeTask[],
  extra: Partial<RepoMaintenanceTarget> = {}
): RepoMaintenanceTarget {
  return { key, tasks: tasks.map((fake) => fake.task), ...extra }
}

/** Resolves the first time a pack starts, so tests never race the scheduler. */
function packStartSignal(): {
  started: Promise<PackedRefsLockReporter>
  onStart: (lock: PackedRefsLockReporter) => void
} {
  let onStart: (lock: PackedRefsLockReporter) => void = () => {}
  const started = new Promise<PackedRefsLockReporter>((resolve) => {
    onStart = resolve
  })
  return { started, onStart }
}

function yieldToIo(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve))
}

/**
 * Spins the real event loop until `predicate` holds. Bounded by wall clock
 * rather than by a turn count: a loaded CI runner exhausts a fixed number of
 * turns long before the work finishes, which fails as a confusing assertion
 * somewhere else.
 */
async function until(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!predicate() && Date.now() < deadline) {
    await yieldToIo()
  }
  if (!predicate()) {
    throw new Error(`timed out after 10s waiting for ${what}`)
  }
}

/**
 * Like `until`, but for conditions that also need a scheduled retry to fire:
 * spinning the real loop alone can never satisfy them, because `setTimeout` is
 * faked. Alternates advancing the fake clock with yielding to real I/O.
 */
async function untilWithTimers(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!predicate() && Date.now() < deadline) {
    await vi.advanceTimersByTimeAsync(QUIET_MS)
    await yieldToIo()
  }
  if (!predicate()) {
    throw new Error(`timed out after 10s waiting for ${what}`)
  }
}

/** Fires the quiet-period timer and waits for the attempt it starts. */
async function elapseQuietPeriod(maintenance: RepoMaintenance, periods = 1): Promise<void> {
  await vi.advanceTimersByTimeAsync(QUIET_MS * periods)
  await maintenance.whenAttemptSettled()
}

beforeEach(() => {
  // Date too: user activity is a timestamp, so it has to age with the timers.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('RepoMaintenance gating', () => {
  it('packs only after the repo has been quiet for the full period', async () => {
    const refs = fakeTask('refs')
    const { maintenance, spans } = createHarness()
    const repo = target('local::/repo/.git', [refs])

    maintenance.arm(repo)
    await vi.advanceTimersByTimeAsync(QUIET_MS - 1)
    expect(refs.pack).not.toHaveBeenCalled()

    // A second write restarts the countdown rather than shortening it.
    maintenance.arm(repo)
    await vi.advanceTimersByTimeAsync(QUIET_MS - 1)
    expect(refs.pack).not.toHaveBeenCalled()

    await elapseQuietPeriod(maintenance)
    expect(refs.pack).toHaveBeenCalledTimes(1)
    expect(attributesOf(spans[0])).toMatchObject({
      'repo.maintenance_outcome': 'completed',
      'repo.maintenance_key': 'local::/repo/.git',
      'repo.maintenance.refs.outcome': 'packed',
      'repo.maintenance.refs.backlog': THRESHOLD,
      'repo.maintenance.refs.backlog_after': 0
    })
  })

  it('leaves a healthy repository alone', async () => {
    const refs = fakeTask('refs', { backlog: THRESHOLD - 1 })
    const { maintenance, spans } = createHarness()

    maintenance.arm(target('local::/healthy/.git', [refs]))
    await elapseQuietPeriod(maintenance)

    expect(refs.pack).not.toHaveBeenCalled()
    expect(attributesOf(spans[0])).toMatchObject({
      'repo.maintenance.refs.outcome': 'below_threshold',
      'repo.maintenance.refs.backlog': THRESHOLD - 1
    })
  })

  it('does not run while the app is busy', async () => {
    const refs = fakeTask('refs')
    let busy = true
    const { maintenance, spans } = createHarness({
      activity: () => ({ interactive: busy, constrained: false })
    })

    maintenance.arm(target('local::/busy/.git', [refs]))
    await elapseQuietPeriod(maintenance)
    expect(refs.pack).not.toHaveBeenCalled()
    expect(spans).toHaveLength(0)

    // The deferral re-arms on a backed-off delay, so the next window picks it up.
    busy = false
    await elapseQuietPeriod(maintenance, 2)
    expect(refs.pack).toHaveBeenCalledTimes(1)
  })

  it('does not run while the repo itself has work in flight', async () => {
    const refs = fakeTask('refs')
    const { maintenance } = createHarness()

    maintenance.arm(target('local::/fetching/.git', [refs], { isBusy: () => true }))
    await elapseQuietPeriod(maintenance)

    expect(refs.pack).not.toHaveBeenCalled()
  })

  it('honours a user who disabled Git auto-maintenance for the repo', async () => {
    const refs = fakeTask('refs')
    const objects = fakeTask('objects')
    const { maintenance, spans } = createHarness()

    maintenance.arm(
      target('local::/opted-out/.git', [refs, objects], { isOptedOut: async () => true })
    )
    await elapseQuietPeriod(maintenance)

    // Both tasks, not just the one that happens to run first.
    expect(refs.pack).not.toHaveBeenCalled()
    expect(objects.pack).not.toHaveBeenCalled()
    expect(attributesOf(spans[0])['repo.maintenance_outcome']).toBe('opted_out')
  })

  it('never reads a truncated probe as a clean repository', async () => {
    // A probe that stopped early reports a floor, so a low count is not evidence
    // of health: three items under a threshold of five still has to pack.
    let saturated = true
    const refs = fakeTask('refs', {
      backlog: 3,
      pack: async (_lock, setBacklog) => {
        saturated = false
        setBacklog(0)
      }
    })
    const probe = refs.task.probeBacklog.bind(refs.task)
    refs.task.probeBacklog = async (budget, signal) => {
      const scan = await probe(budget, signal)
      return scan ? { ...scan, saturated } : scan
    }
    const { maintenance, spans } = createHarness()

    maintenance.arm(target('local::/saturated/.git', [refs]))
    await elapseQuietPeriod(maintenance)

    expect(refs.pack).toHaveBeenCalledTimes(1)
    expect(attributesOf(spans[0])['repo.maintenance.refs.outcome']).toBe('packed')
  })

  it('does not owe another turn to a pack that finished and left the backlog', async () => {
    // Not a spent batch: the task took everything it meant to and the backlog is
    // still there, which is a failing repository, not one with work remaining.
    const refs = fakeTask('refs', { pack: async () => {} })
    const { maintenance, spans } = createHarness()

    maintenance.arm(target('local::/undrained/.git', [refs]))
    await elapseQuietPeriod(maintenance)
    expect(attributesOf(spans[0])['repo.maintenance.refs.outcome']).toBe('failed')

    await vi.advanceTimersByTimeAsync(REMAINDER_MS * 4)
    await maintenance.whenAttemptSettled()
    expect(refs.pack).toHaveBeenCalledTimes(1)
  })

  it('records a repo whose packed-refs lock is held, and retries sooner than a failure', async () => {
    const refs = fakeTask('refs', {
      pack: async () => {
        throw new RepoMaintenanceRepoLocked('our own lock, not yet old enough to reclaim')
      }
    })
    const { maintenance, spans } = createHarness()

    maintenance.arm(target('local::/locked/.git', [refs]))
    await elapseQuietPeriod(maintenance)

    expect(attributesOf(spans[0])['repo.maintenance.refs.outcome']).toBe('locked')
  })

  it('skips a repository whose common dir cannot be resolved', async () => {
    const refs = fakeTask('refs', { unresolved: true })
    const { maintenance, spans } = createHarness()

    maintenance.arm(target('local::/gone/.git', [refs]))
    await elapseQuietPeriod(maintenance)

    expect(refs.pack).not.toHaveBeenCalled()
    expect(attributesOf(spans[0])['repo.maintenance.refs.outcome']).toBe('unresolved')
  })
})

describe('RepoMaintenance task windows', () => {
  const INTERACTIVE = { interactive: true, constrained: false }
  const CONSTRAINED = { interactive: false, constrained: true }
  const IDLE = { interactive: false, constrained: false }

  it('runs an unconstrained task beside live agents while the ref task waits', async () => {
    let activity = INTERACTIVE
    const refs = fakeTask('refs')
    const objects = fakeTask('objects', { window: 'unconstrained' })
    const { maintenance, spans } = createHarness({ activity: () => activity })

    maintenance.arm(target('local::/agents/.git', [refs, objects]))
    await elapseQuietPeriod(maintenance)

    expect(objects.pack).toHaveBeenCalledTimes(1)
    expect(refs.pack).not.toHaveBeenCalled()
    expect(attributesOf(spans[0])).toMatchObject({
      'repo.maintenance_skipped': 'refs',
      'repo.maintenance_outcome': 'deferred'
    })

    // The skipped ref task is still owed, and runs once the agents go quiet.
    activity = IDLE
    await elapseQuietPeriod(maintenance, 2)
    expect(refs.pack).toHaveBeenCalledTimes(1)
    expect(objects.pack).toHaveBeenCalledTimes(1)
  })

  it('holds every task off while the machine itself is constrained', async () => {
    let activity = CONSTRAINED
    const refs = fakeTask('refs')
    const objects = fakeTask('objects', { window: 'unconstrained' })
    const { maintenance, spans } = createHarness({ activity: () => activity })

    maintenance.arm(target('local::/battery/.git', [refs, objects]))
    await elapseQuietPeriod(maintenance)

    expect(objects.pack).not.toHaveBeenCalled()
    expect(refs.pack).not.toHaveBeenCalled()
    // Nothing admitted, so no attempt and no git subprocess at all.
    expect(spans).toHaveLength(0)

    activity = IDLE
    await elapseQuietPeriod(maintenance, 2)
    expect(objects.pack).toHaveBeenCalledTimes(1)
  })

  it('does not let a returning user hold off an unconstrained task', async () => {
    const refs = fakeTask('refs')
    const objects = fakeTask('objects', { window: 'unconstrained' })
    const { maintenance } = createHarness()

    maintenance.arm(target('local::/focused/.git', [refs, objects]))
    await vi.advanceTimersByTimeAsync(QUIET_MS - 1)
    maintenance.recordUserActivity()
    // The original countdown fires one tick later, with the user one tick gone.
    await vi.advanceTimersByTimeAsync(1)
    await maintenance.whenAttemptSettled()

    expect(objects.pack).toHaveBeenCalledTimes(1)
    expect(refs.pack).not.toHaveBeenCalled()

    // The user went quiet a full period ago; the ref task gets its window.
    await elapseQuietPeriod(maintenance)
    expect(refs.pack).toHaveBeenCalledTimes(1)
  })

  it('never gives up on a repository just because the user keeps coming back', async () => {
    const refs = fakeTask('refs')
    const { maintenance } = createHarness()

    maintenance.arm(target('local::/returning/.git', [refs]))
    // Far more returns than the deferral budget; each is one quiet period.
    for (let round = 0; round < 12; round += 1) {
      await vi.advanceTimersByTimeAsync(QUIET_MS - 1)
      maintenance.recordUserActivity()
    }
    expect(refs.pack).not.toHaveBeenCalled()

    await elapseQuietPeriod(maintenance, 2)
    expect(refs.pack).toHaveBeenCalledTimes(1)
  })
})

describe('RepoMaintenance task set', () => {
  it('runs refs before objects inside one attempt', async () => {
    const order: string[] = []
    const refs = fakeTask('refs', {
      pack: async () => {
        order.push('refs')
      }
    })
    const objects = fakeTask('objects', {
      pack: async () => {
        order.push('objects')
      }
    })
    const { maintenance, spans } = createHarness()

    maintenance.arm(target('local::/both/.git', [refs, objects]))
    await elapseQuietPeriod(maintenance)

    expect(order).toEqual(['refs', 'objects'])
    // One attempt, one admission slot, one span.
    expect(spans).toHaveLength(1)
    expect(attributesOf(spans[0])['repo.maintenance_tasks']).toBe('refs,objects')
  })

  it('keeps one task on cooldown from silencing the other', async () => {
    let clock = 0
    const { maintenance, spans } = createHarness({ now: () => clock })
    // Refs pack cleanly, so they cool down for twelve hours; objects stay below
    // threshold, so they cool down for six and come due first. Each arming
    // builds a fresh target, exactly as a fetch does in production, so only the
    // per-task cooldown the scheduler keeps can hold a task back.
    const armBoth = (): { refs: FakeTask; objects: FakeTask } => {
      const armed = { refs: fakeTask('refs'), objects: fakeTask('objects', { backlog: 0 }) }
      maintenance.arm(target('local::/mixed/.git', [armed.refs, armed.objects]))
      return armed
    }

    const first = armBoth()
    await elapseQuietPeriod(maintenance)
    expect(first.refs.pack).toHaveBeenCalledTimes(1)
    expect(attributesOf(spans[0])['repo.maintenance_tasks']).toBe('refs,objects')

    // Past the clean cooldown but inside the packed one: only objects is due.
    clock = REPO_MAINTENANCE_CLEAN_COOLDOWN_MS + 1
    const second = armBoth()
    await elapseQuietPeriod(maintenance)

    expect(second.refs.pack).not.toHaveBeenCalled()
    expect(attributesOf(spans[1])['repo.maintenance_tasks']).toBe('objects')
  })

  it('re-arms for the remainder when a batch was spent but the backlog was not', async () => {
    // Three batches' worth of backlog and a batch that clears one of them.
    const objects = fakeTask('objects', { backlog: THRESHOLD * 3, batch: THRESHOLD })
    const { maintenance, spans } = createHarness()

    maintenance.arm(target('local::/backlogged/.git', [objects]))
    await elapseQuietPeriod(maintenance)
    expect(objects.pack).toHaveBeenCalledTimes(1)
    expect(attributesOf(spans[0])['repo.maintenance.objects.outcome']).toBe('partially_packed')

    // No cooldown was started, so the remainder delay is enough to pick it up again.
    await vi.advanceTimersByTimeAsync(REMAINDER_MS)
    await maintenance.whenAttemptSettled()
    expect(objects.pack).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(REMAINDER_MS)
    await maintenance.whenAttemptSettled()
    expect(objects.pack).toHaveBeenCalledTimes(3)
    expect(objects.backlog()).toBe(0)
    expect(attributesOf(spans[2])['repo.maintenance.objects.outcome']).toBe('packed')

    // Drained, so the post-pack cooldown now holds and nothing re-arms.
    await vi.advanceTimersByTimeAsync(QUIET_MS * 8)
    await maintenance.whenAttemptSettled()
    expect(objects.pack).toHaveBeenCalledTimes(3)
  })

  it('defers the rest of the attempt when the quiet window closes between tasks', async () => {
    let busy = false
    const refs = fakeTask('refs', {
      pack: async (_lock, setBacklog) => {
        setBacklog(0)
        busy = true
      }
    })
    const objects = fakeTask('objects')
    const { maintenance, spans } = createHarness({
      activity: () => ({ interactive: busy, constrained: false })
    })

    maintenance.arm(target('local::/interrupted/.git', [refs, objects]))
    await elapseQuietPeriod(maintenance)

    expect(refs.pack).toHaveBeenCalledTimes(1)
    expect(objects.pack).not.toHaveBeenCalled()
    expect(attributesOf(spans[0])['repo.maintenance_outcome']).toBe('deferred')

    // The deferral re-arms, and the refs cooldown means only objects is left.
    busy = false
    await elapseQuietPeriod(maintenance, 2)
    expect(refs.pack).toHaveBeenCalledTimes(1)
    expect(objects.pack).toHaveBeenCalledTimes(1)
  })
})

describe('RepoMaintenance single-flight and backoff', () => {
  it('runs one repository at a time', async () => {
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

    maintenance.arm(target('local::/a/.git', [fakeTask('refs', { pack: slowPack })]))
    maintenance.arm(target('local::/b/.git', [fakeTask('refs', { pack: slowPack })]))
    await vi.advanceTimersByTimeAsync(QUIET_MS)
    await until(() => concurrent === 1, 'a pack to start')
    expect(concurrent).toBe(1)

    releases.shift()?.()
    await maintenance.whenAttemptSettled()
    // The second repo was deferred behind the first, so its retry is on a timer.
    await untilWithTimers(() => concurrent === 1, 'the second repo to start')
    releases.shift()?.()
    await maintenance.whenAttemptSettled()

    expect(peak).toBe(1)
    expect(concurrent).toBe(0)
  })

  it('waits out the rewrite window instead of killing the pack', async () => {
    let finished = false
    let release: (() => void) | undefined
    const { maintenance } = createHarness()
    const started = packStartSignal()
    const refs = fakeTask('refs', {
      pack: async (lock) => {
        lock.setHeld(true)
        started.onStart(lock)
        await new Promise<void>((resolve) => {
          release = () => {
            lock.setHeld(false)
            resolve()
          }
        })
        finished = true
      }
    })

    maintenance.arm(target('local::/yield/.git', [refs]))
    await vi.advanceTimersByTimeAsync(QUIET_MS)
    await started.started

    let paused = false
    void maintenance.pause('worktree-remove').then(() => {
      paused = true
    })
    await vi.advanceTimersByTimeAsync(1)
    // Blocked while the rewrite window is open...
    expect(paused).toBe(false)
    expect(finished).toBe(false)

    release?.()
    await until(() => paused, 'pause() to resolve')
    // ...and released without the pack ever being cancelled.
    expect(paused).toBe(true)
    expect(finished).toBe(true)
  })

  it('gives up waiting on the lock rather than blocking the user indefinitely', async () => {
    const { maintenance } = createHarness()
    const started = packStartSignal()
    const refs = fakeTask('refs', {
      pack: async (lock) => {
        lock.setHeld(true)
        started.onStart(lock)
        await new Promise<void>(() => {})
      }
    })

    maintenance.arm(target('local::/stuck-lock/.git', [refs]))
    await vi.advanceTimersByTimeAsync(QUIET_MS)
    await started.started

    let paused = false
    void maintenance.pause('git-fetch').then(() => {
      paused = true
    })
    await vi.advanceTimersByTimeAsync(PACKED_REFS_LOCK_WAIT_MS)
    await until(() => paused, 'pause() to resolve')

    expect(paused).toBe(true)
  })

  it('reopens the window only when the last overlapping caller releases', async () => {
    const refs = fakeTask('refs')
    const { maintenance } = createHarness()

    const outer = await maintenance.pause('worktree-add')
    const inner = await maintenance.pause('git-fetch')
    maintenance.arm(target('local::/nested/.git', [refs]))

    await elapseQuietPeriod(maintenance, 8)
    expect(refs.pack).not.toHaveBeenCalled()

    inner()
    await elapseQuietPeriod(maintenance, 8)
    expect(refs.pack).not.toHaveBeenCalled()

    outer()
    await elapseQuietPeriod(maintenance, 8)
    expect(refs.pack).toHaveBeenCalledTimes(1)
  })

  it('holds every armed ref task off for a quiet period after the user does ref work', async () => {
    const { maintenance } = createHarness()
    const firstPack = packStartSignal()
    const a = fakeTask('refs', {
      pack: async (lock) => {
        firstPack.onStart(lock)
      }
    })
    const b = fakeTask('refs')

    maintenance.arm(target('local::/a/.git', [a]))
    maintenance.arm(target('local::/b/.git', [b]))
    await vi.advanceTimersByTimeAsync(QUIET_MS - 1)

    // A manual fetch says the user is at the keyboard, so nothing may fire yet.
    maintenance.recordUserActivity()
    await vi.advanceTimersByTimeAsync(QUIET_MS - 1)
    expect(a.pack).not.toHaveBeenCalled()
    expect(b.pack).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(QUIET_MS)
    await firstPack.started
    expect(a.pack).toHaveBeenCalled()
  })

  it('costs nothing when no pack is running', async () => {
    const { maintenance } = createHarness()

    const release = await maintenance.pause('git-fetch')
    release()
    // Releasing twice must not leave the window wedged shut.
    release()
    const refs = fakeTask('refs')
    maintenance.arm(target('local::/free/.git', [refs]))
    await elapseQuietPeriod(maintenance)

    expect(refs.pack).toHaveBeenCalledTimes(1)
  })

  it('does not re-pack a repository inside its cooldown', async () => {
    let clock = 0
    const { maintenance, spans } = createHarness({ now: () => clock })
    // A fresh full backlog each time, as a fetch produces in production, so only
    // the cooldown can hold the second attempt off.
    const armBacklogged = (): FakeTask => {
      const refs = fakeTask('refs')
      maintenance.arm(target('local::/cooldown/.git', [refs]))
      return refs
    }

    const first = armBacklogged()
    await elapseQuietPeriod(maintenance)
    expect(first.pack).toHaveBeenCalledTimes(1)

    clock = REPO_MAINTENANCE_PACKED_COOLDOWN_MS - 1
    const second = armBacklogged()
    await elapseQuietPeriod(maintenance)
    expect(second.pack).not.toHaveBeenCalled()
    // Not even an admission slot: the cooldown is read before the attempt starts.
    expect(spans).toHaveLength(1)

    clock = REPO_MAINTENANCE_PACKED_COOLDOWN_MS + 1
    const third = armBacklogged()
    await elapseQuietPeriod(maintenance)
    expect(third.pack).toHaveBeenCalledTimes(1)
  })

  it('counts a pack that could not lock every ref as a success', async () => {
    // Field-observed on a machine running several Orca sessions: a branch moved
    // mid-pack, Git reported an error, and 36,688 loose refs still became 3.
    // Retrying that aggressively would be wrong -- the backlog is gone.
    const refs = fakeTask('refs', {
      pack: async (_lock, setBacklog) => {
        setBacklog(0)
        throw new Error("error: cannot lock ref 'refs/heads/moved'")
      }
    })
    const { maintenance, spans } = createHarness()

    maintenance.arm(target('local::/raced/.git', [refs]))
    await elapseQuietPeriod(maintenance)

    expect(attributesOf(spans[0])).toMatchObject({
      'repo.maintenance.refs.outcome': 'packed',
      'repo.maintenance.refs.partial': true,
      'repo.maintenance.refs.backlog_after': 0
    })

    // And it serves the full post-pack cooldown rather than retrying.
    maintenance.arm(target('local::/raced/.git', [fakeTask('refs')]))
    await elapseQuietPeriod(maintenance)
    expect(spans).toHaveLength(1)
  })

  it('records a failure when the pack left the backlog in place', async () => {
    const refs = fakeTask('refs', {
      pack: async () => {
        throw new Error('permission denied')
      }
    })
    const { maintenance, spans } = createHarness()

    maintenance.arm(target('local::/denied/.git', [refs]))
    await elapseQuietPeriod(maintenance)

    expect(attributesOf(spans[0])['repo.maintenance.refs.outcome']).toBe('failed')
  })

  it('records a failure instead of throwing, and backs off', async () => {
    const refs = fakeTask('refs', {
      pack: async () => {
        throw new Error('packed-refs.lock exists')
      }
    })
    const { maintenance, spans } = createHarness()

    maintenance.arm(target('local::/failing/.git', [refs]))
    await elapseQuietPeriod(maintenance)
    expect(attributesOf(spans[0])['repo.maintenance.refs.outcome']).toBe('failed')

    const retried = fakeTask('refs')
    maintenance.arm(target('local::/failing/.git', [retried]))
    await elapseQuietPeriod(maintenance)
    expect(retried.pack).not.toHaveBeenCalled()
  })

  it('stops scheduling once disposed', async () => {
    const refs = fakeTask('refs')
    const { maintenance } = createHarness()

    maintenance.arm(target('local::/disposed/.git', [refs]))
    maintenance.dispose()
    await elapseQuietPeriod(maintenance)

    expect(refs.pack).not.toHaveBeenCalled()
  })
})
