import { execFileSync } from 'node:child_process'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { selectLatestStableReleaseTag } from '../../../config/scripts/stable-release-tags.mjs'
import {
  populateReleaseCheckoutSource,
  resolveSharedReleaseCacheRoot
} from './release-source-cache.ts'
import {
  CHECKOUT_FORMAT,
  publishReleaseCheckout,
  type MaterializeReleaseCheckoutTestHooks
} from './release-checkout-publication.ts'
export type {
  CheckoutLockOptions,
  CheckoutLifecycleContext,
  CheckoutStagingContext,
  MaterializeReleaseCheckoutTestHooks
} from './release-checkout-publication.ts'

export { selectLatestStableReleaseTag }

export const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..')
const DEFAULT_CACHE_ROOT = join(REPO_ROOT, 'tests', 'e2e', '.cross-version-checkouts')

const BASELINE_REF_ENV = 'ORCA_CROSS_VERSION_BASELINE_REF'

export type ReleaseCheckout = {
  ref: string
  commit: string
  /** Directory name under the cache root; also the dynamic-import path segment. */
  label: string
  root: string
}

export type MaterializeReleaseCheckoutOptions = {
  cacheRoot?: string
  sharedCacheRoot?: string
  /** Test-only lifecycle seams; production callers must use the defaults. */
  testHooks?: MaterializeReleaseCheckoutTestHooks
}

function git(args: string[]): string {
  return execFileSync('git', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
}

// Prefer the explicit baseline override, then the newest stable desktop tag; missing baselines must fail rather than skip.
export function resolveBaselineReleaseRef(): string {
  const override = process.env[BASELINE_REF_ENV]?.trim()
  if (override) {
    return override
  }
  let tags: string[]
  try {
    tags = git(['tag', '--list', 'v[0-9]*']).split('\n').filter(Boolean)
  } catch (error) {
    throw new Error(
      `Cross-version harness could not list git tags in ${REPO_ROOT}: ${String(error)}. ` +
        `Run it inside a git checkout, or pin a ref with ${BASELINE_REF_ENV}.`
    )
  }
  const latest = selectLatestStableReleaseTag(tags)
  if (!latest) {
    throw new Error(
      `Cross-version harness found no stable desktop release tags matching vX.Y.Z (saw ${tags.length} tag(s) total). ` +
        'CI checkouts default to a shallow clone with no tags: use `actions/checkout` with `fetch-depth: 0`, ' +
        `or pin a ref with ${BASELINE_REF_ENV}.`
    )
  }
  return latest
}

/** The newest `count` stable desktop releases, newest first: the ones a downgrade can reach. */
export function resolveRecentStableReleaseRefs(count: number): string[] {
  let tags = git(['tag', '--list', 'v[0-9]*']).split('\n').filter(Boolean)
  const recent: string[] = []
  while (recent.length < count) {
    const latest = selectLatestStableReleaseTag(tags)
    if (!latest) {
      throw new Error(
        `Cross-version harness found ${recent.length} of ${count} stable desktop release tags; ` +
          'a shallow CI clone needs `fetch-depth: 0`.'
      )
    }
    recent.push(latest)
    tags = tags.filter((tag) => tag !== latest)
  }
  return recent
}

function resolveCommit(ref: string): string {
  try {
    return git(['rev-parse', `${ref}^{commit}`])
  } catch (error) {
    throw new Error(
      `Cross-version harness could not resolve ref "${ref}" to a commit: ${String(error)}. ` +
        'The ref must exist locally; a shallow CI clone needs `fetch-depth: 0`.'
    )
  }
}

function checkoutModulePath(root: string, rootRelativePath: string): string {
  const fromRoot = rootRelativePath.replace(/^[/\\]+/, '')
  const absolute = resolve(root, fromRoot)
  const fromCheckout = relative(root, absolute)
  if (
    !fromRoot ||
    fromCheckout === '..' ||
    fromCheckout.startsWith(`..${sep}`) ||
    isAbsolute(fromCheckout)
  ) {
    throw new Error(
      `Cross-version module path must stay inside the release checkout: ${rootRelativePath}`
    )
  }
  return absolute.split('\\').join('/')
}

// Pass raw absolute forward-slash paths: CI vite-node treats file:// URLs as root-relative ids (run 33049571360).
export function importReleaseCheckoutModule(
  checkout: ReleaseCheckout,
  rootRelativePath: string,
  importModule: (specifier: string) => Promise<Record<string, unknown>> = (specifier) =>
    import(/* @vite-ignore */ specifier) as Promise<Record<string, unknown>>
): Promise<Record<string, unknown>> {
  return importModule(checkoutModulePath(checkout.root, rootRelativePath))
}

/** An export a release module must define; callers name the shape they use, so a changed one fails the test. */
export function releaseModuleExport<T>(module: Record<string, unknown>, name: string): T {
  const value = module[name]
  if (value === undefined) {
    throw new Error(`the release module exports no ${name}`)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: release modules are typed unknown; a missing export throws above and a reshaped one fails its caller.
  return value as T
}

// Copy under the root tsconfig because root-only CI lacks Expo’s mobile config; pin relative imports to working-tree sources.
export async function importWorkingTreeModuleCopy(
  rootRelativePath: string,
  cacheRoot: string = DEFAULT_CACHE_ROOT
): Promise<Record<string, unknown>> {
  const copy = checkoutModulePath(join(cacheRoot, 'working-tree'), rootRelativePath)
  const original = checkoutModulePath(REPO_ROOT, rootRelativePath)
  const staged = `${copy}.${process.pid}.tmp`
  await mkdir(dirname(copy), { recursive: true })
  const source = await readFile(original, 'utf8')
  await writeFile(
    staged,
    source.replace(
      /(\bfrom\s*)(['"])(\.\.?\/[^'"]+)\2/g,
      (_match, from: string, quote: string, specifier: string) =>
        `${from}${quote}${resolve(dirname(original), specifier).split('\\').join('/')}${quote}`
    )
  )
  // Rename so a concurrent run never imports a half-written copy.
  await rename(staged, copy)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a module namespace is a plain record of its exports; callers narrow each export they read.
  return import(/* @vite-ignore */ copy) as Promise<Record<string, unknown>>
}

// Cache extracted source by resolved commit and rewrite format so moved tags cannot reuse stale trees.
export async function materializeReleaseCheckout(
  ref: string,
  options: MaterializeReleaseCheckoutOptions = {}
): Promise<ReleaseCheckout> {
  const commit = resolveCommit(ref)
  const label = ref.replace(/[^A-Za-z0-9._-]/g, '_')
  const cacheRoot = options.cacheRoot ?? DEFAULT_CACHE_ROOT
  const root = join(cacheRoot, label, `${commit}-format-${CHECKOUT_FORMAT}`)
  await publishReleaseCheckout({
    root,
    ref,
    commit,
    hooks: options.testHooks,
    populateStaging: async (staging) => {
      const sharedCacheRoot =
        options.sharedCacheRoot ??
        (await resolveSharedReleaseCacheRoot(REPO_ROOT, options.cacheRoot))
      await populateReleaseCheckoutSource(REPO_ROOT, staging, commit, sharedCacheRoot)
    }
  })
  return { ref, commit, label, root }
}
