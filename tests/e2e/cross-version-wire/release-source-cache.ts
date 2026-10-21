import { cp, mkdir, readFile, readdir, rename, rm, utimes, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  makeTreeReadOnlyAsync,
  shareTreeAsync
} from '../../../config/scripts/space-sharing-copy.mjs'
import { extractReleaseCheckoutTree } from './release-checkout-tree.ts'
import { installMissingPackageStandIns, type PackageImports } from './release-missing-packages.ts'
import { publishReleaseCheckout } from './release-checkout-publication.ts'
import { pruneSharedReleaseSources, withReleaseSourceLease } from './release-source-retention.ts'

const IMPORTS_FILENAME = 'release-package-imports.json'

export async function populateReleaseCheckoutSource(
  repoRoot: string,
  staging: string,
  commit: string,
  sharedCacheRoot: string | undefined
): Promise<void> {
  if (sharedCacheRoot) {
    try {
      await populateFromSharedReleaseSource(repoRoot, staging, commit, sharedCacheRoot)
      return
    } catch (error) {
      console.warn(
        `[cross-version] Shared release source unavailable; extracting locally: ${String(error)}`
      )
      await rm(staging, { recursive: true, force: true })
      await mkdir(staging, { recursive: true })
    }
  }
  await extractReleaseCheckoutTree(repoRoot, staging, commit)
}

function readPackageImports(value: unknown): PackageImports {
  if (!Array.isArray(value)) {
    throw new Error('Invalid cached release package imports')
  }
  const result: PackageImports = new Map()
  for (const entry of value) {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      typeof entry[0] !== 'string' ||
      !Array.isArray(entry[1])
    ) {
      throw new Error('Invalid cached release package imports')
    }
    const names = entry[1].filter((name): name is string => typeof name === 'string')
    if (names.length !== entry[1].length) {
      throw new Error('Invalid cached release import names')
    }
    result.set(entry[0], new Set(names))
  }
  return result
}

export async function populateFromSharedReleaseSource(
  repoRoot: string,
  staging: string,
  commit: string,
  sharedCacheRoot: string,
  { extract = extractReleaseCheckoutTree, copy = copySharedReleaseSource } = {}
): Promise<void> {
  await withReleaseSourceLease(sharedCacheRoot, async (formatRoot, verifyLease) => {
    const seed = join(formatRoot, commit)
    try {
      await pruneSharedReleaseSources(formatRoot, commit, verifyLease)
      await publishReleaseCheckout({
        root: seed,
        ref: commit,
        commit,
        populateStaging: async (seedStaging) => {
          const imports = await extract(repoRoot, seedStaging, commit, true)
          await writeFile(
            join(seedStaging, IMPORTS_FILENAME),
            JSON.stringify([...imports].map(([specifier, names]) => [specifier, [...names]]))
          )
        },
        prepareForPublication: async (seedStaging) => {
          verifyLease()
          await makeTreeReadOnlyAsync(seedStaging)
          verifyLease()
        }
      })
      const imports = readPackageImports(
        JSON.parse(await readFile(join(seed, IMPORTS_FILENAME), 'utf8'))
      )
      const copied = join(staging, '.release-source')
      verifyLease()
      await copy(seed, copied)
      verifyLease()
      for (const entry of await readdir(copied)) {
        if (entry !== 'checkout-stamp.json' && entry !== IMPORTS_FILENAME) {
          await rename(join(copied, entry), join(staging, entry))
        }
      }
      await rm(copied, { recursive: true, force: true })
      const now = new Date()
      await utimes(seed, now, now)
      await installMissingPackageStandIns(
        staging,
        commit,
        imports,
        JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'))
      )
    } catch (error) {
      verifyLease()
      await rm(seed, { recursive: true, force: true }).catch(() => {})
      throw error
    }
  })
}

export async function copySharedReleaseSource(
  source: string,
  destination: string,
  platform: NodeJS.Platform = process.platform
): Promise<void> {
  try {
    await shareTreeAsync(
      source,
      destination,
      platform === 'win32'
        ? {
            platform,
            hardlink: async () => {
              throw new Error('Windows removal changes hardlink permissions')
            }
          }
        : { platform }
    )
  } catch {
    await cp(source, destination, { recursive: true, dereference: false, verbatimSymlinks: true })
  }
}

export async function resolveSharedReleaseCacheRoot(
  repoRoot: string,
  isolatedCacheRoot?: string
): Promise<string | undefined> {
  if (
    isolatedCacheRoot ||
    process.env.CI ||
    process.env.ORCA_DISABLE_SHARED_RELEASE_CACHE === '1'
  ) {
    return undefined
  }
  try {
    const { runProcess } = await import('@orca/process-host')
    const result = await runProcess({
      program: 'git',
      args: ['rev-parse', '--git-common-dir'],
      cwd: repoRoot,
      timeoutMs: 10_000,
      terminationBarrier: true
    })
    if (result.code !== 0 || result.timedOut) {
      return undefined
    }
    const common = result.stdout.replace(process.platform === 'win32' ? /\r?\n$/ : /\n$/, '')
    if (!common || common.includes('\n')) {
      return undefined
    }
    return join(resolve(repoRoot, common), 'orca-cache', 'release-source')
  } catch {
    return undefined
  }
}
