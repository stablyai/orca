/**
 * Proves the substring/char-code guards added to `cross-platform-path.ts` and `parseWslUncPath`
 * are pure fast paths: a seeded differential fuzz against the pre-guard copy in
 * `cross-platform-path-unguarded.test-fixture.ts`, plus counters that fail if the guards regress.
 */
import { describe, expect, it, afterEach } from 'vitest'
import * as guarded from './cross-platform-path'
import * as unguarded from './cross-platform-path-unguarded.test-fixture'
import { parseWslUncPath } from './wsl-paths'

// ─── Deterministic path generator ────────────────────────────────────

function createRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const PREFIXES = [
  '',
  '/',
  '//',
  '///',
  '.',
  './',
  '../',
  'C:/',
  'c:\\',
  'Z:',
  '\\\\',
  '\\\\wsl.localhost\\Ubuntu',
  '//wsl.localhost/Ubuntu-22.04',
  '//WSL$/Debian',
  '\\\\wsl$\\ubuntu',
  '//server/share',
  '/mnt/c',
  '\\\\wsl.localhost\\Ubuntu\\mnt\\c'
]

// NFD + KELVIN SIGN are the folds `normalizeRuntimePathForComparison` is built around.
const SEGMENTS = [
  'home',
  'user',
  'orca',
  'workspaces',
  '..',
  '.',
  '',
  'a',
  'B',
  'wsl$',
  'wsl.localhost',
  'mnt',
  'c',
  'C',
  'répertoire',
  're\u0301pertoire',
  '\u212Aelvin',
  'Kelvin',
  'back\\slash',
  'sp ace',
  'Ubuntu'
]

const JOINERS = ['/', '/', '/', '//', '///', '\\', '\\\\']
const SUFFIXES = ['', '', '', '/', '//', '\\', '/.', '/..']

function generatePath(random: () => number): string {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]
  let path = pick(PREFIXES)
  const segmentCount = Math.floor(random() * 5)
  for (let index = 0; index < segmentCount; index++) {
    path += (path === '' ? '' : pick(JOINERS)) + pick(SEGMENTS)
  }
  return path + pick(SUFFIXES)
}

/** Roots that actually contain the candidate, so the matching branches get exercised too. */
function generateRoot(random: () => number, candidate: string): string {
  const roll = random()
  if (roll < 0.35) {
    const cut = Math.floor(random() * (candidate.length + 1))
    return candidate.slice(0, cut)
  }
  if (roll < 0.45) {
    return candidate
  }
  return generatePath(random)
}

// ─── Differential fuzz ───────────────────────────────────────────────

const FUZZ_ITERATIONS = 20_000

describe('guarded path normalization matches the pre-guard implementation', () => {
  it(`agrees on every export across ${FUZZ_ITERATIONS} seeded paths`, () => {
    const random = createRandom(0x5eed)
    const mismatches: string[] = []
    const record = (label: string, path: string, root: string): void => {
      if (mismatches.length < 5) {
        mismatches.push(`${label}: candidate=${JSON.stringify(path)} root=${JSON.stringify(root)}`)
      }
    }

    for (let iteration = 0; iteration < FUZZ_ITERATIONS; iteration++) {
      const path = generatePath(random)
      const root = generateRoot(random, path)
      const distro = Math.floor(random() * 2) === 0 ? 'Ubuntu' : 'debian'

      const singles: [string, (value: string) => unknown, (value: string) => unknown][] = [
        [
          'isWindowsAbsolutePathLike',
          guarded.isWindowsAbsolutePathLike,
          unguarded.isWindowsAbsolutePathLike
        ],
        [
          'isCaseInsensitiveRuntimeRoot',
          guarded.isCaseInsensitiveRuntimeRoot,
          unguarded.isCaseInsensitiveRuntimeRoot
        ],
        [
          'normalizeRuntimePathSeparators',
          guarded.normalizeRuntimePathSeparators,
          unguarded.normalizeRuntimePathSeparators
        ],
        [
          'normalizeRuntimePathForComparison',
          guarded.normalizeRuntimePathForComparison,
          unguarded.normalizeRuntimePathForComparison
        ],
        ['isRuntimePathAbsolute', guarded.isRuntimePathAbsolute, unguarded.isRuntimePathAbsolute],
        ['getRuntimePathBasename', guarded.getRuntimePathBasename, unguarded.getRuntimePathBasename]
      ]
      for (const [label, left, right] of singles) {
        if (left(path) !== right(path)) {
          record(label, path, root)
        }
      }

      const identity = guarded.getLocalWindowsWslPathIdentity(path)
      const expectedIdentity = unguarded.getLocalWindowsWslPathIdentity(path)
      if (
        identity.normalizedPath !== expectedIdentity.normalizedPath ||
        identity.aliasComparisonPath !== expectedIdentity.aliasComparisonPath ||
        identity.isWslUnc !== expectedIdentity.isWslUnc
      ) {
        record('getLocalWindowsWslPathIdentity', path, root)
      }
      const wslUnc = parseWslUncPath(path)
      const expectedWslUnc = unguarded.parseWslUncPath(path)
      if (
        wslUnc?.distro !== expectedWslUnc?.distro ||
        wslUnc?.linuxPath !== expectedWslUnc?.linuxPath
      ) {
        record('parseWslUncPath', path, root)
      }
      if (
        guarded.areLocalWindowsWslPathAliases(root, path) !==
        unguarded.areLocalWindowsWslPathAliases(root, path)
      ) {
        record('areLocalWindowsWslPathAliases', path, root)
      }
      if (
        guarded.isWslUncPathForCallerLinuxPath(root, path, distro) !==
        unguarded.isWslUncPathForCallerLinuxPath(root, path, distro)
      ) {
        record('isWslUncPathForCallerLinuxPath', path, root)
      }
      if (
        guarded.isWslUncPathForLinuxMountedPath(root, path) !==
        unguarded.isWslUncPathForLinuxMountedPath(root, path)
      ) {
        record('isWslUncPathForLinuxMountedPath', path, root)
      }
      if (guarded.resolveRuntimePath(root, path) !== unguarded.resolveRuntimePath(root, path)) {
        record('resolveRuntimePath', path, root)
      }
      if (guarded.isPathInsideOrEqual(root, path) !== unguarded.isPathInsideOrEqual(root, path)) {
        record('isPathInsideOrEqual', path, root)
      }
      if (
        guarded.createNormalizedPathInsideOrEqualMatcher(root)(
          guarded.normalizeRuntimePathForComparison(path)
        ) !==
        unguarded.createNormalizedPathInsideOrEqualMatcher(root)(
          unguarded.normalizeRuntimePathForComparison(path)
        )
      ) {
        record('createNormalizedPathInsideOrEqualMatcher', path, root)
      }
      if (
        guarded.relativePathInsideRoot(root, path) !== unguarded.relativePathInsideRoot(root, path)
      ) {
        record('relativePathInsideRoot', path, root)
      }
    }

    expect(mismatches).toEqual([])
  }, 120_000)
})

// ─── The guards must not skip work that was actually needed ──────────

describe('guards still do the work when the fast path does not apply', () => {
  it('collapses doubled slashes', () => {
    expect(guarded.normalizeRuntimePathForComparison('/a//b///c')).toBe('/a/b/c')
    expect(guarded.normalizeRuntimePathSeparators('/a//b')).toBe('/a/b')
    expect(guarded.relativePathInsideRoot('/a', '/a//b//c')).toBe('b/c')
  })

  it('trims trailing slashes but keeps bare roots', () => {
    expect(guarded.normalizeRuntimePathForComparison('/a/b/')).toBe('/a/b')
    expect(guarded.normalizeRuntimePathForComparison('/a/b//')).toBe('/a/b')
    expect(guarded.normalizeRuntimePathForComparison('/')).toBe('/')
    expect(guarded.normalizeRuntimePathForComparison('C:/')).toBe('c:/')
  })

  it('folds backslashes only on Windows-shaped paths', () => {
    expect(guarded.normalizeRuntimePathForComparison('C:\\a\\b')).toBe('c:/a/b')
    expect(guarded.normalizeRuntimePathSeparators('C:\\a\\\\b')).toBe('C:/a/b')
    // Backslash is a legal POSIX filename character and must survive.
    expect(guarded.normalizeRuntimePathForComparison('/a/b\\c')).toBe('/a/b\\c')
  })

  it('still parses both WSL UNC aliases in either separator spelling', () => {
    expect(parseWslUncPath('\\\\wsl.localhost\\Ubuntu\\home\\me')).toEqual({
      distro: 'Ubuntu',
      linuxPath: '/home/me'
    })
    expect(parseWslUncPath('//wsl$/Debian/srv')).toEqual({ distro: 'Debian', linuxPath: '/srv' })
    expect(guarded.normalizeRuntimePathForComparison('\\\\wsl.localhost\\Ubuntu\\Repo')).toBe(
      '//wsl/ubuntu/Repo'
    )
    expect(parseWslUncPath('/wsl.localhost/Ubuntu/home')).toBeNull()
    expect(parseWslUncPath('/')).toBeNull()
    expect(parseWslUncPath('')).toBeNull()
  })
})

// ─── Regression guards: counted work, not wall clock ─────────────────

const originalReplace = String.prototype.replace

afterEach(() => {
  String.prototype.replace = originalReplace
})

function countReplaceCalls(run: () => void): number {
  let calls = 0
  String.prototype.replace = function (this: string, ...args: never[]) {
    calls++
    return originalReplace.apply(this, args as never)
  } as typeof String.prototype.replace
  try {
    run()
  } finally {
    String.prototype.replace = originalReplace
  }
  return calls
}

const CLEAN_POSIX_PATH =
  '/Users/nwparker/orca/workspaces/orca/perf/src/renderer/src/components/x.ts'

describe('no-op regex passes stay skipped', () => {
  it('runs zero replaces for a path with no doubled slash, trailing slash, or backslash', () => {
    expect(
      countReplaceCalls(() => guarded.normalizeRuntimePathForComparison(CLEAN_POSIX_PATH))
    ).toBe(0)
    expect(countReplaceCalls(() => guarded.normalizeRuntimePathSeparators(CLEAN_POSIX_PATH))).toBe(
      0
    )
    expect(countReplaceCalls(() => parseWslUncPath(CLEAN_POSIX_PATH))).toBe(0)
  })

  it('runs one replace per pass that is genuinely needed', () => {
    expect(countReplaceCalls(() => guarded.normalizeRuntimePathForComparison('/a//b'))).toBe(1)
    expect(countReplaceCalls(() => guarded.normalizeRuntimePathForComparison('/a/b/'))).toBe(1)
  })
})

// ─── One root-bound factory, one input contract ──────────────────────

/**
 * `createNormalizedPathInsideOrEqualMatcher` demands an already-normalized candidate because
 * `normalizeRuntimePathForComparison` is not idempotent. A sibling factory on the same root that
 * took RAW candidates would put two opposite contracts one line apart, and mixing them up returns
 * "outside the root" rather than throwing. Hoisting a root out of a loop is worth ~0.2 us/event;
 * this is the price. Keep the raw-candidate entry point the plain `relativePathInsideRoot` call.
 */
describe('cross-platform-path exposes a single root-bound factory', () => {
  it('has no raw-candidate sibling to the normalized matcher', () => {
    expect(Object.keys(guarded).filter((name) => name.startsWith('create'))).toEqual([
      'createNormalizedPathInsideOrEqualMatcher'
    ])
  })

  it('shows what mixing the two contracts would cost', () => {
    const root = '//wsl.localhost/Ubuntu/Repo'
    const candidate = '//wsl.localhost/Ubuntu/Repo/src/App.tsx'
    const normalizedCandidate = guarded.normalizeRuntimePathForComparison(candidate)
    expect(guarded.normalizeRuntimePathForComparison(normalizedCandidate)).not.toBe(
      normalizedCandidate
    )

    const matcher = guarded.createNormalizedPathInsideOrEqualMatcher(root)
    expect(matcher(normalizedCandidate)).toBe(true)
    // The raw spelling a resolver would accept is silently reported as outside the root.
    expect(matcher(candidate)).toBe(false)
    expect(guarded.relativePathInsideRoot(root, candidate)).toBe('src/App.tsx')
  })
})
