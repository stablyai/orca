import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RepoRefMaintenance } from './repo-ref-maintenance'
import type {
  PackedRefsLockReporter,
  RefMaintenanceSpan,
  RepoRefMaintenanceOptions,
  RepoRefMaintenanceTarget
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
  packRefs: ((lock: PackedRefsLockReporter) => Promise<void>) & { mock: { calls: unknown[] } }
}

function createHarness(
  overrides: Partial<RepoRefMaintenanceOptions> & {
    packRefs?: (lock: PackedRefsLockReporter) => Promise<void>
  } = {}
): Harness {
  const spans: RefMaintenanceSpan[] = []
  const packRefs = vi.fn<(lock: PackedRefsLockReporter) => Promise<void>>(
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
  packRefs: (lock: PackedRefsLockReporter) => Promise<void>,
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

/** Yield real I/O while timers are faked; wall-clock bounds tolerate loaded CI better than fixed turn counts. */
async function until(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!predicate() && Date.now() < deadline) {
    await yieldToIo()
  }
  if (!predicate()) {
    throw new Error(`timed out after 10s waiting for ${what}`)
  }
}

/** Only the quiet-period timer is faked; real filesystem I/O still has to complete. */
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
})

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('RepoRefMaintenance single-flight and backoff', () => {
  it('waits out the rewrite window instead of killing the pack', async () => {
    const refs = await refsDirectoryWith(THRESHOLD + 2)
    let finished = false
    let release: (() => void) | undefined
    const { maintenance } = createHarness()
    const started = packStartSignal()

    maintenance.arm(
      target('local::/yield/.git', refs, async (lock) => {
        lock.setHeld(true)
        started.onStart(lock)
        await new Promise<void>((resolve) => {
          release = () => {
            lock.setHeld(false)
            resolve()
          }
        })
        finished = true
      })
    )
    await vi.advanceTimersByTimeAsync(QUIET_MS)
    await started.started

    let paused = false
    void maintenance.pause('worktree-remove').then(() => {
      paused = true
    })
    await vi.advanceTimersByTimeAsync(1)
    expect(paused).toBe(false)
    expect(finished).toBe(false)

    release?.()
    await until(() => paused, 'pause() to resolve')
    expect(paused).toBe(true)
    expect(finished).toBe(true)
  })
})
