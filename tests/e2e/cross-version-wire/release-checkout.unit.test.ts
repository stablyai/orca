import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { lock } from 'proper-lockfile'
import { afterEach, describe, expect, it } from 'vitest'
import { forceTerminateProcessTree } from '../../../src/shared/child-process/process-tree-termination'
import { spawnProcess } from '../../../src/shared/child-process/run-process'
import {
  importReleaseCheckoutModule,
  materializeReleaseCheckout,
  REPO_ROOT,
  type CheckoutLockOptions,
  type CheckoutStagingContext,
  type ReleaseCheckout
} from './release-checkout'
const temporaryRoots: string[] = []

const COMPRESSED_LOCK_OPTIONS: CheckoutLockOptions = {
  realpath: false,
  stale: 2_500,
  update: 1_000,
  retries: { retries: 200, factor: 1, minTimeout: 50, maxTimeout: 50, randomize: false }
}

function temporaryCacheRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'orca-cross-version-checkout-'))
  temporaryRoots.push(root)
  return root
}

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
}

function syntheticCheckout(): ReleaseCheckout {
  // Why realpath: vite-node reports module urls through macOS's /var -> /private/var
  // symlink, so provenance assertions need the resolved form.
  const root = realpathSync(temporaryCacheRoot())
  return { ref: 'v0.0.0-synthetic', commit: 'f'.repeat(40), label: 'v0.0.0-synthetic', root }
}

function waitForCondition(
  description: string,
  condition: () => boolean,
  timeoutMs: number
): Promise<void> {
  const startedAt = Date.now()
  return new Promise((resolvePoll, rejectPoll) => {
    const poll = (): void => {
      if (condition()) {
        resolvePoll()
        return
      }
      if (Date.now() - startedAt > timeoutMs) {
        rejectPoll(new Error(`Timed out after ${timeoutMs}ms waiting for ${description}`))
        return
      }
      setTimeout(poll, 25)
    }
    poll()
  })
}

function waitForFile(path: string, timeoutMs: number): Promise<void> {
  return waitForCondition(path, () => existsSync(path), timeoutMs)
}

async function populateMinimalStaging({ staging }: CheckoutStagingContext): Promise<void> {
  const shared = join(staging, 'src', 'shared')
  mkdirSync(shared, { recursive: true })
  writeFileSync(join(shared, 'terminal-stream-protocol.ts'), 'export const synthetic = true\n')
}

type MaterializerChildConfig = {
  cacheRoot: string
  ref: string
  resultPath?: string
  attemptMarker?: string
  acquiredMarker?: string
  stagingMarker?: string
  proceedPath?: string
  ablateLock?: boolean
  populateStaging?: boolean
  hangAfterStaging?: boolean
  lockOptions?: CheckoutLockOptions
}

type ObservedMaterializerChild = {
  child: ReturnType<typeof spawnProcess>
  exited: Promise<number | null>
  output: () => string
}

function startMaterializerChild(
  scratch: string,
  name: string,
  config: MaterializerChildConfig
): ObservedMaterializerChild {
  const script = join(scratch, `${name}.mjs`)
  const harnessUrl = new URL('./release-checkout.ts', import.meta.url).href
  writeFileSync(
    script,
    [
      `const { existsSync, mkdirSync, writeFileSync } = await import('node:fs')`,
      `const { join } = await import('node:path')`,
      `const harness = await import(${JSON.stringify(harnessUrl)})`,
      `const config = ${JSON.stringify(config)}`,
      `const waitForPath = async (path) => {`,
      `  const startedAt = Date.now()`,
      `  while (!existsSync(path)) {`,
      `    if (Date.now() - startedAt > 30000) throw new Error('timed out waiting for ' + path)`,
      `    await new Promise((resolve) => setTimeout(resolve, 10))`,
      `  }`,
      `}`,
      `const hooks = { lockOptions: config.lockOptions }`,
      `if (config.ablateLock) hooks.acquireLock = async () => async () => {}`,
      `if (config.attemptMarker) hooks.onLockAttempt = () => writeFileSync(config.attemptMarker, '')`,
      `if (config.acquiredMarker) hooks.onLockAcquired = () => writeFileSync(config.acquiredMarker, '')`,
      `if (config.stagingMarker) {`,
      `  hooks.onStagingCreated = async ({ root, staging }) => {`,
      `    writeFileSync(config.stagingMarker, JSON.stringify({ root, staging }))`,
      `    if (config.hangAfterStaging) await new Promise(() => setInterval(() => {}, 1000))`,
      `    if (config.proceedPath) await waitForPath(config.proceedPath)`,
      `  }`,
      `}`,
      `if (config.populateStaging) {`,
      `  hooks.populateStaging = async ({ staging }) => {`,
      `    const shared = join(staging, 'src', 'shared')`,
      `    mkdirSync(shared, { recursive: true })`,
      `    writeFileSync(join(shared, 'terminal-stream-protocol.ts'), 'export const synthetic = true\\n')`,
      `  }`,
      `}`,
      `try {`,
      `  const checkout = await harness.materializeReleaseCheckout(config.ref, { cacheRoot: config.cacheRoot, testHooks: hooks })`,
      `  if (config.resultPath) writeFileSync(config.resultPath, JSON.stringify({ root: checkout.root }))`,
      `} catch (error) {`,
      `  if (config.resultPath) writeFileSync(config.resultPath, JSON.stringify({ error: String(error) }))`,
      `  process.exitCode = 1`,
      `}`,
      ''
    ].join('\n')
  )

  const child = spawnProcess({
    program: process.execPath,
    args: [script],
    cwd: REPO_ROOT,
    env: { ...process.env, NODE_OPTIONS: '' },
    terminationBarrier: true
  })
  let childOutput = ''
  child.stdout.on('data', (chunk) => {
    childOutput += String(chunk)
  })
  child.stderr.on('data', (chunk) => {
    childOutput += String(chunk)
  })
  const exited = new Promise<number | null>((resolveExit, rejectExit) => {
    child.once('error', rejectExit)
    child.once('close', resolveExit)
  })
  return { child, exited, output: () => childOutput }
}

async function stopMaterializerChild(observed: ObservedMaterializerChild): Promise<void> {
  if (observed.child.exitCode === null && observed.child.signalCode === null) {
    await forceTerminateProcessTree(observed.child)
  }
  await observed.exited.catch(() => null)
}

async function runContentionPhase(
  published: ReleaseCheckout,
  scratch: string,
  phase: string,
  ablateLock: boolean
): Promise<boolean> {
  const sentinel = join(published.root, `in-use-sentinel-${phase}.mjs`)
  const aside = join(scratch, `published-aside-${phase}`)
  const attemptMarker = join(scratch, `rival-attempted-${phase}`)
  const acquiredMarker = join(scratch, `rival-acquired-${phase}`)
  const stagingMarker = join(scratch, `rival-staging-${phase}`)
  const proceedPath = join(scratch, `rival-proceed-${phase}`)
  const resultPath = join(scratch, `rival-result-${phase}.json`)
  writeFileSync(sentinel, "export const sentinel = 'published-tree'\n")
  renameSync(published.root, aside)
  const releaseLock = await lock(published.root, { realpath: false, stale: 60_000 })
  let released = false
  let rival: ObservedMaterializerChild | undefined
  const releaseOnce = async (): Promise<void> => {
    if (!released) {
      released = true
      await releaseLock()
    }
  }

  try {
    rival = startMaterializerChild(scratch, `rival-${phase}`, {
      cacheRoot: join(published.root, '..', '..'),
      ref: published.ref,
      resultPath,
      attemptMarker,
      acquiredMarker,
      ...(ablateLock ? { ablateLock, stagingMarker, proceedPath, populateStaging: true } : {})
    })
    // onLockAttempt runs only after the rival's first stamp miss and invocation
    // of the actual lock function; no elapsed-time guess stands in for contention.
    await waitForFile(ablateLock ? stagingMarker : attemptMarker, 30_000)
    if (!ablateLock) {
      expect(existsSync(acquiredMarker), rival.output()).toBe(false)
    }

    renameSync(aside, published.root)
    const consuming = importReleaseCheckoutModule(published, `/in-use-sentinel-${phase}.mjs`).then(
      (value) => value,
      (error: unknown) => error
    )
    if (ablateLock) {
      // The staging marker is after the second stamp miss. Publishing before this
      // acknowledgement would let the ablation pass without exercising deletion.
      writeFileSync(proceedPath, '')
    }
    await releaseOnce()

    const exitCode = await rival.exited
    const result = JSON.parse(readFileSync(resultPath, 'utf8')) as Record<string, unknown>
    expect(result, rival.output()).toEqual({ root: published.root })
    expect(exitCode, rival.output()).toBe(0)
    expect(existsSync(acquiredMarker), rival.output()).toBe(true)
    const consumerResult = await consuming
    if (!ablateLock) {
      expect(consumerResult).toMatchObject({ sentinel: 'published-tree' })
    }
    return existsSync(sentinel)
  } finally {
    if (rival) {
      await stopMaterializerChild(rival)
    }
    if (existsSync(aside) && !existsSync(published.root)) {
      renameSync(aside, published.root)
    }
    await releaseOnce()
  }
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('release checkout materialization', () => {
  it('single-flights concurrent consumers of one release identity', async () => {
    const cacheRoot = temporaryCacheRoot()
    const checkouts = await Promise.all([
      materializeReleaseCheckout('v1.4.190', { cacheRoot }),
      materializeReleaseCheckout('v1.4.190', { cacheRoot }),
      materializeReleaseCheckout('v1.4.190', { cacheRoot })
    ])

    expect(new Set(checkouts.map(({ root }) => root))).toHaveLength(1)
    expect(relative(cacheRoot, checkouts[0]!.root)).not.toMatch(/^\.\./)
  })

  it('loads a baseline module whose source imports another checkout-root file', async () => {
    const cacheRoot = temporaryCacheRoot()
    const checkout = await materializeReleaseCheckout('v1.4.190', { cacheRoot })
    const protocol = await importReleaseCheckoutModule(checkout, '/src/shared/protocol-version.ts')

    expect(protocol.REMOTE_SERVER_UPDATE_CAPABILITY).toBe('updater.remote-control.v1')
    expect(relative(cacheRoot, checkout.root)).not.toMatch(/^\.\./)
  })

  it('keeps an import live while another colliding release label materializes', async () => {
    const merge = git(['rev-list', '--merges', '-1', 'HEAD'])
    const firstRef = `${merge}~2`
    const secondRef = `${merge}^2`
    expect(git(['rev-parse', `${firstRef}^{commit}`])).not.toBe(
      git(['rev-parse', `${secondRef}^{commit}`])
    )

    const cacheRoot = temporaryCacheRoot()
    const first = await materializeReleaseCheckout(firstRef, { cacheRoot })
    const dependency = join(first.root, 'delayed-dependency.mjs')
    const entry = join(first.root, 'delayed-entry.mjs')
    writeFileSync(dependency, "export const loaded = 'first-release'\n")
    writeFileSync(
      entry,
      'await new Promise((resolve) => setTimeout(resolve, 100))\n' +
        "export const loaded = (await import('./delayed-dependency.mjs')).loaded\n"
    )

    const loading = importReleaseCheckoutModule(first, '/delayed-entry.mjs')
    const second = await materializeReleaseCheckout(secondRef, { cacheRoot })

    await expect(loading).resolves.toMatchObject({ loaded: 'first-release' })
    expect(first.root).not.toBe(second.root)
  })

  it('causally single-flights a rival process before publishing an in-use checkout', async () => {
    const cacheRoot = temporaryCacheRoot()
    const scratch = temporaryCacheRoot()
    const published = await materializeReleaseCheckout('v1.4.190', { cacheRoot })

    await expect(runContentionPhase(published, scratch, 'locked', false)).resolves.toBe(true)
    // In the same causally acknowledged interleaving, a no-lock materializer
    // deletes the newly published tree. This makes the lock assertion non-vacuous.
    await expect(runContentionPhase(published, scratch, 'ablated', true)).resolves.toBe(false)
  }, 120_000)

  it('keeps the real lock live while publication work exceeds its stale interval', async () => {
    const cacheRoot = temporaryCacheRoot()
    const scratch = temporaryCacheRoot()
    const attemptMarker = join(scratch, 'heartbeat-rival-attempted')
    const acquiredMarker = join(scratch, 'heartbeat-rival-acquired')
    const resultPath = join(scratch, 'heartbeat-rival-result.json')
    let releaseWork!: () => void
    const workGate = new Promise<void>((resolveWork) => {
      releaseWork = resolveWork
    })
    let acknowledgeStaging!: (context: CheckoutStagingContext) => void
    const stagingReady = new Promise<CheckoutStagingContext>((resolveStaging) => {
      acknowledgeStaging = resolveStaging
    })
    const publisher = materializeReleaseCheckout('v1.4.190', {
      cacheRoot,
      testHooks: {
        lockOptions: COMPRESSED_LOCK_OPTIONS,
        onStagingCreated: async (context) => {
          acknowledgeStaging(context)
          await workGate
        },
        populateStaging: populateMinimalStaging
      }
    })
    const active = await stagingReady
    const rival = startMaterializerChild(scratch, 'heartbeat-rival', {
      cacheRoot,
      ref: 'v1.4.190',
      resultPath,
      attemptMarker,
      acquiredMarker,
      lockOptions: COMPRESSED_LOCK_OPTIONS
    })

    try {
      await waitForFile(attemptMarker, 30_000)
      const blockedAt = Date.now()
      const mtimes = new Set<number>()
      await waitForCondition(
        'multiple lock heartbeats beyond the stale interval',
        () => {
          if (existsSync(`${active.root}.lock`)) {
            mtimes.add(statSync(`${active.root}.lock`).mtimeMs)
          }
          return Date.now() - blockedAt > COMPRESSED_LOCK_OPTIONS.stale + 250 && mtimes.size >= 3
        },
        15_000
      )
      expect(existsSync(acquiredMarker), rival.output()).toBe(false)
      expect(existsSync(active.staging)).toBe(true)

      releaseWork()
      await publisher
      const exitCode = await rival.exited
      expect(exitCode, rival.output()).toBe(0)
      expect(existsSync(acquiredMarker), rival.output()).toBe(true)
      expect(JSON.parse(readFileSync(resultPath, 'utf8')), rival.output()).toEqual({
        root: active.root
      })
    } finally {
      releaseWork()
      await stopMaterializerChild(rival)
      await publisher.catch(() => undefined)
    }
  }, 30_000)

  it('recovers a crashed lock owner and scavenges only its orphaned staging trees', async () => {
    const cacheRoot = temporaryCacheRoot()
    const scratch = temporaryCacheRoot()
    const stagingMarker = join(scratch, 'crashed-staging')
    const crashed = startMaterializerChild(scratch, 'crashing-publisher', {
      cacheRoot,
      ref: 'v1.4.190',
      stagingMarker,
      hangAfterStaging: true,
      lockOptions: COMPRESSED_LOCK_OPTIONS
    })

    try {
      await waitForFile(stagingMarker, 30_000)
      const crashedContext = JSON.parse(readFileSync(stagingMarker, 'utf8')) as {
        root: string
        staging: string
      }
      const lockPath = `${crashedContext.root}.lock`
      expect(existsSync(crashedContext.staging)).toBe(true)
      expect(existsSync(lockPath)).toBe(true)
      await forceTerminateProcessTree(crashed.child)
      const crashExit = await crashed.exited
      expect(crashExit, crashed.output()).not.toBe(0)
      expect(existsSync(lockPath)).toBe(true)

      const unrelated = join(crashedContext.staging, '..', '.staging-unrelated-live-owner')
      mkdirSync(unrelated)
      const recovered = await materializeReleaseCheckout('v1.4.190', {
        cacheRoot,
        testHooks: {
          lockOptions: COMPRESSED_LOCK_OPTIONS,
          populateStaging: populateMinimalStaging
        }
      })

      expect(existsSync(crashedContext.staging)).toBe(false)
      expect(existsSync(unrelated)).toBe(true)
      expect(existsSync(join(recovered.root, 'src', 'shared', 'terminal-stream-protocol.ts'))).toBe(
        true
      )
    } finally {
      await stopMaterializerChild(crashed)
    }
  }, 30_000)

  it('never stamps an incomplete tree produced through the injectable test seam', async () => {
    const cacheRoot = temporaryCacheRoot()
    await expect(
      materializeReleaseCheckout('v1.4.190', {
        cacheRoot,
        testHooks: { populateStaging: async () => undefined }
      })
    ).rejects.toThrow(/missing the terminal stream protocol/)

    let populated = 0
    const recovered = await materializeReleaseCheckout('v1.4.190', {
      cacheRoot,
      testHooks: {
        populateStaging: async (context) => {
          populated++
          await populateMinimalStaging(context)
        }
      }
    })
    expect(populated).toBe(1)
    expect(existsSync(join(recovered.root, 'src', 'shared', 'terminal-stream-protocol.ts'))).toBe(
      true
    )
  })
})

describe('release checkout module importer', () => {
  it('hands the importer a raw absolute forward-slash specifier, never a file URL', async () => {
    const checkout = syntheticCheckout()
    const captured: string[] = []
    const capture = (specifier: string): Promise<Record<string, unknown>> => {
      captured.push(specifier)
      return Promise.resolve({})
    }

    await importReleaseCheckoutModule(checkout, '/src/main/runtime/rpc/dispatcher.ts', capture)
    await importReleaseCheckoutModule(checkout, '\\src\\shared\\protocol-version.ts', capture)

    const normalizedRoot = checkout.root.split('\\').join('/')
    expect(captured).toEqual([
      `${normalizedRoot}/src/main/runtime/rpc/dispatcher.ts`,
      `${normalizedRoot}/src/shared/protocol-version.ts`
    ])
    for (const specifier of captured) {
      expect(specifier).not.toMatch(/^file:/)
      expect(specifier).not.toContain('\\')
    }
  })

  it('refuses module paths that escape the checkout root', () => {
    const checkout = syntheticCheckout()
    const escape = /stay inside the release checkout/
    expect(() => importReleaseCheckoutModule(checkout, '/src/../../escape.ts')).toThrow(escape)
    expect(() => importReleaseCheckoutModule(checkout, '..')).toThrow(escape)
    expect(() => importReleaseCheckoutModule(checkout, '')).toThrow(escape)
  })

  it('anchors root-relative modules to the checkout root, never the working tree', async () => {
    const checkout = syntheticCheckout()
    mkdirSync(join(checkout.root, 'src'), { recursive: true })
    writeFileSync(
      join(checkout.root, 'src', 'provenance-probe.mjs'),
      'export const moduleUrl = import.meta.url\n'
    )

    const probe = await importReleaseCheckoutModule(checkout, '/src/provenance-probe.mjs')
    expect(String(probe.moduleUrl)).toContain(checkout.root.split('\\').join('/'))

    // The working tree has this module and the synthetic checkout does not:
    // resolving it would mean a root-relative specifier silently ran current
    // code as the "old" side — the exact poison this harness exists to prevent.
    await expect(
      importReleaseCheckoutModule(checkout, '/src/shared/protocol-version.ts')
    ).rejects.toThrow()
  })
})
