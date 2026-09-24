import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * One Playwright worker imports many spec files into one Node process, and the app fixtures
 * launch Electron with a spread of that process's `process.env`. A module-scope write therefore
 * reconfigures every app launched by every spec that follows in the same worker — and it runs at
 * import time, before any hook or `finally` exists that could undo it, so unlike a write inside a
 * test body it cannot be restored at all.
 *
 * That is not a hypothetical: a parking-delay override written this way shrank the terminal
 * cold-park delay from 30s to 2s for later specs, which unmounted panes those specs still needed.
 * Use `test.use({ orcaAppExtraEnv })`, which Playwright scopes to the file.
 */
const E2E_ROOT = resolve(__dirname)

/**
 * Module scope is read off column 0. The tree is prettier-formatted, so every statement nested in
 * a function, hook, block, or `app.evaluate` callback is indented — including the in-body writes
 * that legitimately save and restore around a relaunch. A write that starts a line is top-level.
 */
const MODULE_SCOPE_ENV_WRITE =
  /^(?:process\.env\.[A-Za-z_][A-Za-z0-9_]*\s*(?:\??\|\||\?\?|)=[^=]|process\.env\[|delete\s+process\.env[.[]|Object\.assign\(\s*process\.env)/

/**
 * The count of files writing `process.env` at module scope.
 *
 * May only ever be DECREASED. Raising it is never the fix: the replacement is a fixture option,
 * which is strictly more capable here because it reaches the app launch without touching the
 * worker every other spec shares.
 */
const MODULE_SCOPE_ENV_WRITER_PIN = 0

const SCANNED_EXTENSIONS = ['.ts', '.tsx']
const IGNORED_DIRECTORIES = new Set(['node_modules', 'dist', 'out', 'build', '__fixtures__'])

function collectE2eFiles(root: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(root)) {
    if (IGNORED_DIRECTORIES.has(entry)) {
      continue
    }
    const path = join(root, entry)
    if (statSync(path).isDirectory()) {
      found.push(...collectE2eFiles(path))
    } else if (SCANNED_EXTENSIONS.some((extension) => path.endsWith(extension))) {
      found.push(path)
    }
  }
  return found
}

function findModuleScopeEnvWrites(path: string): string[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .flatMap((line, index) =>
      MODULE_SCOPE_ENV_WRITE.test(line)
        ? [`${relative(E2E_ROOT, path)}:${index + 1}: ${line.trim()}`]
        : []
    )
}

describe('e2e worker env isolation', () => {
  const offenders = collectE2eFiles(E2E_ROOT).flatMap(findModuleScopeEnvWrites)

  it('no e2e file writes process.env at module scope', () => {
    expect(offenders).toEqual([])
  })

  it('holds the module-scope env writer count at its ratchet', () => {
    const files = new Set(offenders.map((offender) => offender.split(':')[0]))
    expect(files.size).toBeLessThanOrEqual(MODULE_SCOPE_ENV_WRITER_PIN)
  })

  it('detects the shape it is meant to catch', () => {
    // Guards the regex itself: a green that cannot go red would pass this whole file forever.
    expect(MODULE_SCOPE_ENV_WRITE.test("process.env.ORCA_E2E_X ??= '1'")).toBe(true)
    expect(MODULE_SCOPE_ENV_WRITE.test("process.env.ORCA_E2E_X = '1'")).toBe(true)
    expect(MODULE_SCOPE_ENV_WRITE.test('delete process.env.ORCA_E2E_X')).toBe(true)
    expect(MODULE_SCOPE_ENV_WRITE.test("Object.assign(process.env, { ORCA_E2E_X: '1' })")).toBe(
      true
    )
    // Reads, and writes nested in any body, stay legal.
    expect(MODULE_SCOPE_ENV_WRITE.test('const x = Number(process.env.ORCA_E2E_X) || 500')).toBe(
      false
    )
    expect(MODULE_SCOPE_ENV_WRITE.test("  process.env.ORCA_E2E_X = '1'")).toBe(false)
    expect(MODULE_SCOPE_ENV_WRITE.test("if (process.env.ORCA_E2E_X === '1') {")).toBe(false)
  })
})
