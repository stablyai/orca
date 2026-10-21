import { constants } from 'node:fs'
import { access, mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { lock } from 'proper-lockfile'
import { scavengeReleaseCheckoutStaging } from './release-checkout-tree.ts'

export const CHECKOUT_FORMAT = 8

export type CheckoutLockOptions = {
  realpath: false
  stale: number
  update: number
  retries: {
    retries: number
    factor: number
    minTimeout: number
    maxTimeout: number
    randomize: boolean
  }
}

type CheckoutLockRelease = () => Promise<void>
type AcquireCheckoutLock = (
  root: string,
  options: CheckoutLockOptions
) => Promise<CheckoutLockRelease>

export type CheckoutLifecycleContext = {
  root: string
  stagingPrefix: string
}

export type CheckoutStagingContext = CheckoutLifecycleContext & {
  staging: string
}

export type MaterializeReleaseCheckoutTestHooks = {
  lockOptions?: CheckoutLockOptions
  acquireLock?: AcquireCheckoutLock
  onLockAttempt?: (context: CheckoutLifecycleContext) => void
  onLockAcquired?: (context: CheckoutLifecycleContext) => void | Promise<void>
  onStagingCreated?: (context: CheckoutStagingContext) => void | Promise<void>
  populateStaging?: (context: CheckoutStagingContext) => Promise<void>
}

const DEFAULT_LOCK_OPTIONS: CheckoutLockOptions = {
  realpath: false,
  stale: 60_000,
  update: 10_000,
  retries: { retries: 480, factor: 1, minTimeout: 250, maxTimeout: 250, randomize: true }
}

type CheckoutStamp = { commit: string; format: number }

async function readStamp(root: string): Promise<CheckoutStamp | null> {
  try {
    const value: unknown = JSON.parse(await readFile(join(root, 'checkout-stamp.json'), 'utf8'))
    return typeof value === 'object' &&
      value !== null &&
      'commit' in value &&
      typeof value.commit === 'string' &&
      'format' in value &&
      typeof value.format === 'number'
      ? { commit: value.commit, format: value.format }
      : null
  } catch {
    return null
  }
}

async function checkoutMatches(root: string, commit: string): Promise<boolean> {
  const stamp = await readStamp(root)
  if (stamp?.commit !== commit || stamp.format !== CHECKOUT_FORMAT) {
    return false
  }
  try {
    await assertCheckoutWireSurface(root, commit)
    return true
  } catch {
    return false
  }
}

async function assertCheckoutWireSurface(root: string, ref: string): Promise<void> {
  try {
    await access(join(root, 'src', 'shared', 'terminal-stream-protocol.ts'), constants.F_OK)
  } catch {
    throw new Error(
      `Cross-version checkout for ${ref} is missing the terminal stream protocol; ` +
        'the wire surface moved and the harness needs updating.'
    )
  }
}

export async function publishReleaseCheckout({
  root,
  ref,
  commit,
  populateStaging,
  prepareForPublication,
  hooks
}: {
  root: string
  ref: string
  commit: string
  populateStaging: (staging: string) => Promise<void>
  prepareForPublication?: (staging: string) => Promise<void>
  hooks?: MaterializeReleaseCheckoutTestHooks
}): Promise<void> {
  if (await checkoutMatches(root, commit)) {
    return
  }

  const stagingPrefix = `.staging-${commit}-format-${CHECKOUT_FORMAT}-`
  const lifecycleContext = { root, stagingPrefix }
  const lockOptions = hooks?.lockOptions ?? DEFAULT_LOCK_OPTIONS
  const acquireLock: AcquireCheckoutLock =
    hooks?.acquireLock ?? ((target, value) => lock(target, value))
  await mkdir(dirname(root), { recursive: true })
  let releaseLock: CheckoutLockRelease | undefined
  try {
    const acquiring = acquireLock(root, lockOptions)
    try {
      hooks?.onLockAttempt?.(lifecycleContext)
    } catch (error) {
      await acquiring.then(
        async (release) => release(),
        () => undefined
      )
      throw error
    }
    releaseLock = await acquiring
  } catch (error) {
    if (await checkoutMatches(root, commit)) {
      return
    }
    throw new Error(`Cross-version harness could not lock ${ref} (${commit}): ${String(error)}`)
  }

  let staging: string | undefined
  try {
    await hooks?.onLockAcquired?.(lifecycleContext)
    if (await checkoutMatches(root, commit)) {
      return
    }
    await scavengeReleaseCheckoutStaging(dirname(root), stagingPrefix)
    staging = await mkdtemp(join(dirname(root), stagingPrefix))
    const stagingContext = { ...lifecycleContext, staging }
    await hooks?.onStagingCreated?.(stagingContext)
    await (hooks?.populateStaging
      ? hooks.populateStaging(stagingContext)
      : populateStaging(staging))
    await assertCheckoutWireSurface(staging, ref)
    await writeFile(
      join(staging, 'checkout-stamp.json'),
      `${JSON.stringify({ commit, format: CHECKOUT_FORMAT } satisfies CheckoutStamp, null, 2)}\n`
    )
    await prepareForPublication?.(staging)
    await rm(root, { recursive: true, force: true })
    await rename(staging, root)
    staging = undefined
  } catch (error) {
    if (await checkoutMatches(root, commit)) {
      return
    }
    throw new Error(`Cross-version harness failed to extract ${ref} (${commit}): ${String(error)}`)
  } finally {
    if (staging) {
      await rm(staging, { recursive: true, force: true })
    }
    await releaseLock()
  }

  await assertCheckoutWireSurface(root, ref)
}
