import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { lock } from 'proper-lockfile'
import { CHECKOUT_FORMAT, type CheckoutLockOptions } from './release-checkout-publication.ts'

const COMMIT_DIRECTORY = /^(?:[\da-f]{40}|[\da-f]{64})$/
export const MAX_SHARED_RELEASE_SEEDS = 8
const ORPHAN_STAGING = new RegExp(
  `^\\.staging-(?:[\\da-f]{40}|[\\da-f]{64})-format-${CHECKOUT_FORMAT}-[\\da-zA-Z]{6}$`
)
const LEASE_OPTIONS: CheckoutLockOptions = {
  realpath: false,
  stale: 60_000,
  update: 10_000,
  retries: { retries: 480, factor: 1, minTimeout: 250, maxTimeout: 250, randomize: true }
}

export async function withReleaseSourceLease<T>(
  cacheRoot: string,
  apply: (formatRoot: string, verifyLease: () => void) => Promise<T>,
  lockOptions = LEASE_OPTIONS
): Promise<T> {
  return withReleaseSourceFormatLease(cacheRoot, CHECKOUT_FORMAT, apply, lockOptions)
}

export async function withReleaseSourceFormatLease<T>(
  cacheRoot: string,
  format: number,
  apply: (formatRoot: string, verifyLease: () => void) => Promise<T>,
  lockOptions = LEASE_OPTIONS
): Promise<T> {
  const formatRoot = join(cacheRoot, `format-${format}`)
  await mkdir(formatRoot, { recursive: true })
  let compromised: Error | undefined
  const release = await lock(join(formatRoot, 'maintenance'), {
    ...lockOptions,
    onCompromised: (error) => {
      compromised = error
    }
  })
  const verifyLease = (): void => {
    if (compromised) {
      throw compromised
    }
  }
  try {
    verifyLease()
    const result = await apply(formatRoot, verifyLease)
    verifyLease()
    return result
  } finally {
    await release()
  }
}

export async function pruneSharedReleaseSources(
  formatRoot: string,
  keepCommit: string,
  verifyLease: () => void,
  maxSeeds = MAX_SHARED_RELEASE_SEEDS
): Promise<void> {
  const seeds: { name: string; modified: number }[] = []
  for (const entry of await readdir(formatRoot, { withFileTypes: true })) {
    if (entry.isDirectory() && COMMIT_DIRECTORY.test(entry.name)) {
      seeds.push({ name: entry.name, modified: (await stat(join(formatRoot, entry.name))).mtimeMs })
    } else if (entry.isDirectory() && ORPHAN_STAGING.test(entry.name)) {
      verifyLease()
      await rm(join(formatRoot, entry.name), { recursive: true, force: true })
    }
  }
  const others = seeds
    .filter((seed) => seed.name !== keepCommit)
    .sort((a, b) => b.modified - a.modified || a.name.localeCompare(b.name))
  for (const seed of others.slice(maxSeeds - 1)) {
    verifyLease()
    await rm(join(formatRoot, seed.name), { recursive: true, force: true })
  }
}
