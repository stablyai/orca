import { execFileSync } from 'node:child_process'
import { constants } from 'node:fs'
import { access, mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { lock } from 'proper-lockfile'
import {
  extractReleaseCheckoutTree,
  scavengeReleaseCheckoutStaging
} from './release-checkout-tree.ts'

export const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..')
const DEFAULT_CACHE_ROOT = join(REPO_ROOT, 'tests', 'e2e', '.cross-version-checkouts')

// Bump when extraction or the alias rewrite changes so cached trees are rebuilt.
const CHECKOUT_FORMAT = 3

const BASELINE_REF_ENV = 'ORCA_CROSS_VERSION_BASELINE_REF'
const STABLE_DESKTOP_RELEASE_TAG = /^v\d+\.\d+\.\d+$/

export type ReleaseCheckout = {
  /** The ref as requested, e.g. `v1.4.169`. */
  ref: string
  /** Resolved commit the tree was extracted from. */
  commit: string
  /** Directory name under the cache root; also the dynamic-import path segment. */
  label: string
  /** Absolute path to the extracted checkout root (contains `src/`). */
  root: string
}

export type MaterializeReleaseCheckoutOptions = {
  cacheRoot?: string
  /** Test-only lifecycle seams; production callers must use the defaults. */
  testHooks?: MaterializeReleaseCheckoutTestHooks
}

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

function git(args: string[]): string {
  return execFileSync('git', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
}

function compareReleaseTags(a: string, b: string): number {
  const parts = (tag: string): number[] =>
    tag
      .replace(/^v/, '')
      .split('.')
      .map((part) => Number.parseInt(part, 10))
      .map((value) => (Number.isFinite(value) ? value : 0))
  const left = parts(a)
  const right = parts(b)
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0)
    if (diff !== 0) {
      return diff
    }
  }
  return 0
}

/**
 * The version point the harness pairs current code against. An explicit
 * {@link BASELINE_REF_ENV} wins; otherwise the newest stable desktop release tag.
 *
 * Throws rather than skipping: a cross-version lane that quietly runs nothing is
 * the exact failure this harness exists to prevent.
 */
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

export function selectLatestStableReleaseTag(tags: string[]): string | null {
  return (
    tags
      .filter((tag) => STABLE_DESKTOP_RELEASE_TAG.test(tag))
      .sort(compareReleaseTags)
      .at(-1) ?? null
  )
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

type CheckoutStamp = { commit: string; format: number }

async function readStamp(root: string): Promise<CheckoutStamp | null> {
  try {
    return JSON.parse(await readFile(join(root, 'checkout-stamp.json'), 'utf8')) as CheckoutStamp
  } catch {
    return null
  }
}

async function checkoutMatches(root: string, commit: string): Promise<boolean> {
  const stamp = await readStamp(root)
  return stamp?.commit === commit && stamp.format === CHECKOUT_FORMAT
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

function checkoutModulePath(checkout: ReleaseCheckout, rootRelativePath: string): string {
  const fromRoot = rootRelativePath.replace(/^[/\\]+/, '')
  const absolute = resolve(checkout.root, fromRoot)
  const fromCheckout = relative(checkout.root, absolute)
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

/**
 * Import a source module with `/src/...` anchored to the extracted release root.
 *
 * The specifier handed to `importModule` is a raw absolute forward-slash path,
 * never a `file://` URL: CI vite-node resolves URL specifiers as root-relative
 * ids and fails with `ERR_MODULE_NOT_FOUND` (run 33049571360). `importModule`
 * is injectable only so tests can pin that contract deterministically.
 */
export function importReleaseCheckoutModule(
  checkout: ReleaseCheckout,
  rootRelativePath: string,
  importModule: (specifier: string) => Promise<Record<string, unknown>> = (specifier) =>
    import(/* @vite-ignore */ specifier) as Promise<Record<string, unknown>>
): Promise<Record<string, unknown>> {
  return importModule(checkoutModulePath(checkout, rootRelativePath))
}

/**
 * Extract `src/` at `ref` into a cached, gitignored checkout the test can import.
 * Cached by resolved commit, so a moved tag or a bumped rewrite format re-extracts.
 */
export async function materializeReleaseCheckout(
  ref: string,
  options: MaterializeReleaseCheckoutOptions = {}
): Promise<ReleaseCheckout> {
  const commit = resolveCommit(ref)
  const label = ref.replace(/[^A-Za-z0-9._-]/g, '_')
  const cacheRoot = options.cacheRoot ?? DEFAULT_CACHE_ROOT
  const root = join(cacheRoot, label, `${commit}-format-${CHECKOUT_FORMAT}`)
  if (await checkoutMatches(root, commit)) {
    return { ref, commit, label, root }
  }

  const stagingPrefix = `.staging-${commit}-format-${CHECKOUT_FORMAT}-`
  const lifecycleContext = { root, stagingPrefix }
  const hooks = options.testHooks
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
      return { ref, commit, label, root }
    }
    throw new Error(`Cross-version harness could not lock ${ref} (${commit}): ${String(error)}`)
  }

  let staging: string | undefined
  try {
    await hooks?.onLockAcquired?.(lifecycleContext)
    if (await checkoutMatches(root, commit)) {
      return { ref, commit, label, root }
    }
    await scavengeReleaseCheckoutStaging(dirname(root), stagingPrefix)
    staging = await mkdtemp(join(dirname(root), stagingPrefix))
    const stagingContext = { ...lifecycleContext, staging }
    await hooks?.onStagingCreated?.(stagingContext)
    await (hooks?.populateStaging
      ? hooks.populateStaging(stagingContext)
      : extractReleaseCheckoutTree(REPO_ROOT, staging, commit))
    await assertCheckoutWireSurface(staging, ref)
    await writeFile(
      join(staging, 'checkout-stamp.json'),
      `${JSON.stringify({ commit, format: CHECKOUT_FORMAT } satisfies CheckoutStamp, null, 2)}\n`
    )
    await rm(root, { recursive: true, force: true })
    await rename(staging, root)
    staging = undefined
  } catch (error) {
    if (await checkoutMatches(root, commit)) {
      return { ref, commit, label, root }
    }
    throw new Error(`Cross-version harness failed to extract ${ref} (${commit}): ${String(error)}`)
  } finally {
    if (staging) {
      await rm(staging, { recursive: true, force: true })
    }
    await releaseLock()
  }

  await assertCheckoutWireSurface(root, ref)
  return { ref, commit, label, root }
}
