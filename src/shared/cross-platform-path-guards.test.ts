import { afterEach, describe, expect, it } from 'vitest'
import * as guarded from './cross-platform-path'
import { parseWslUncPath } from './wsl-paths'

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
