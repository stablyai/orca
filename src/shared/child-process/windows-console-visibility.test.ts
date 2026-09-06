import { join, resolve } from 'node:path'
import {
  blankStringContents,
  blankStringContentsDesynced,
  readAllowlist,
  scanSourceTree,
  stripComments
} from '../source-scan/source-tree-scan'
import { describe, expect, it } from 'vitest'

/**
 * Every direct child-process call must pass `windowsHide`.
 *
 * Without it a GUI Electron process that spawns a console subsystem binary gets
 * a real console window: it flashes, and it steals foreground. On a git status
 * poll that is once per poll (#10488). `run-process.ts` sets the flag for
 * everything routed through it; this guards the calls that still spawn directly.
 *
 * The flag is inert off Windows, so this asks for it unconditionally rather than
 * making each site reason about its platform.
 *
 * The allowlist only shrinks — it is also the migration worklist. Removing a
 * file from it means either adding the flag or, better, routing the call
 * through the chokepoint.
 */
const ALLOWLIST: readonly string[] = readAllowlist(
  join(__dirname, '__fixtures__', 'windows-console-visibility-allowlist.txt')
)

/**
 * The true count of files spawning without `windowsHide`.
 *
 * May only ever be DECREASED, and only by fixing a call site. Set equality with
 * the allowlist does not bound this: a swap (one file fixed and delisted, one
 * new file added with its entry) satisfies both membership assertions.
 */
const UNHIDDEN_SPAWNER_PIN = 66

const CHILD_PROCESS_IMPORT =
  /from\s+['"](?:node:)?child_process['"]|require\(\s*['"](?:node:)?child_process['"]/
// Includes the promisified and renamed spellings -- `execAsync`, `spawnDetached`,
// `execFileCb` -- because a plain-name regex misses a `promisify(exec)` or an
// `import { spawn as sp }`, and those are real spawns.
const SPAWN_CALL =
  /\b(?:spawn|spawnSync|spawnDetached|execFile|execFileSync|execFileAsync|execFileCb|exec|execSync|execAsync)\s*\(/g
const SOURCE_ROOT = resolve(__dirname, '../..')
/**
 * `run-process.ts` is the chokepoint: it sets windowsHide in `resolveSpawn`,
 * not at the call, so scanning it flags its own implementation.
 *
 * `fork` is deliberately absent from SPAWN_CALL. Node forwards the option to
 * spawn at runtime, but `ForkOptions` does not declare it, so the two live
 * sites (`daemon/daemon-init.ts`, `plugins/plugin-host-process.ts`) cannot be
 * fixed without a cast. Recorded here rather than silently unscanned.
 */
const OWNER_FILE = 'shared/child-process/run-process.ts'

/** The call's argument text, brace-matched so a nested options literal stays whole. */
function readCallArguments(source: string, openParenIndex: number): string {
  let depth = 0
  for (let index = openParenIndex; index < source.length; index += 1) {
    if (source[index] === '(') {
      depth += 1
    } else if (source[index] === ')') {
      depth -= 1
      if (depth === 0) {
        return source.slice(openParenIndex, index)
      }
    }
  }
  return source.slice(openParenIndex)
}

function findOffenders(): string[] {
  const offenders = new Set<string>()
  for (const file of scanSourceTree(SOURCE_ROOT)) {
    if (file.relativePath === OWNER_FILE) {
      continue
    }
    const decommented = stripComments(file.source)
    // Resolve `import { spawn as sp }` so a renamed binding is still a spawn.
    // The previous comment claimed this; only three names were hardcoded.
    const aliases = [
      ...decommented.matchAll(
        /\b(?:spawn|spawnSync|execFile|execFileSync|exec|execSync|fork)\s+as\s+(\w+)/g
      )
    ].map((match) => match[1]!)
    // Names that resolve to `exec`/`execSync`, which imply shell: true.
    const shellImplying = new Set(['exec', 'execSync'])
    for (const match of decommented.matchAll(/\b(exec|execSync)\s+as\s+(\w+)/g)) {
      shellImplying.add(match[2]!)
    }
    // `const run = promisify(execFile)` mints a third name, and it can wrap a
    // renamed binding, so this has to run after the aliases are known. A
    // planted `promisify(renamedExecFile)` spawn passed the guard without it.
    for (const match of decommented.matchAll(
      // `\w*[Pp]romisify` so `import { promisify as p }` is still seen.
      /(?:const|let|var)\s+(\w+)\s*=\s*\w*[Pp]romisify\s*\(\s*(\w+)\s*\)/g
    )) {
      const wrapped = match[2]!
      if (
        aliases.includes(wrapped) ||
        /^(?:spawn|spawnSync|execFile|execFileSync|exec|execSync|fork)$/.test(wrapped)
      ) {
        aliases.push(match[1]!)
        if (shellImplying.has(wrapped)) {
          shellImplying.add(match[1]!)
        }
      }
    }
    // The import test needs the module name, which blanking would erase; the
    // call scan needs parens inside strings neutralised. Two views, one file.
    if (!CHILD_PROCESS_IMPORT.test(decommented)) {
      continue
    }
    // Fail closed: if the lexer lost its bearings, the scan below cannot be
    // trusted, so the file counts as an offender rather than as clean.
    if (blankStringContentsDesynced(decommented)) {
      offenders.add(file.relativePath)
      continue
    }
    const source = blankStringContents(decommented)
    const calls = aliases.length
      ? new RegExp(`${SPAWN_CALL.source}|\\b(?:${aliases.join('|')})\\s*\\(`, 'g')
      : SPAWN_CALL
    for (const match of source.matchAll(calls)) {
      const args = readCallArguments(source, match.index + match[0].length - 1)
      // `exec(command: string, …)` is a declaration. Require a type after the
      // colon: `exec(useAlt ? 'a' : 'b', …)` is a call and was being skipped.
      if (/^\(\s*\w+\s*\??\s*:\s*[A-Za-z{[(]/.test(args)) {
        continue
      }
      // `shell: true` silently makes windowsHide a no-op (run-process.ts,
      // #14543), and `exec`/`execSync` imply it. A site can therefore read as
      // guarded while still flashing a conhost -- which is exactly how
      // `execAsync('where gemini', { windowsHide: true })` got un-allowlisted.
      const called = match[0].replace(/\s*\($/, '').trim()
      // Any `shell:` that is not literally `false` counts. `shell:
      // process.platform === 'win32'` IS shell: true on the platform this
      // guard is about, and only the literal was being matched.
      // Recorded gap, not an oversight: `shell: process.platform === 'win32'`
      // IS shell: true on the platform this guard is about, but matching any
      // non-`false` value also flags `shell: spawnConfig.shell`
      // (claude-accounts/service.ts:1086), a pass-through that is false in
      // every branch. A false positive there costs an allowlist entry, which
      // disables the guard for that whole file -- worse than the gap. No
      // computed `shell:` exists in the tree today; if one appears, resolve it
      // rather than widening this regex.
      const impliesShell = shellImplying.has(called) || /shell\s*:\s*true/.test(args)
      if (!/windowsHide\s*:\s*true/.test(args) || impliesShell) {
        offenders.add(file.relativePath)
      }
    }
  }
  return [...offenders].sort()
}

describe('direct child-process calls hide the Windows console', () => {
  const offenders = findOffenders()

  it('scans a realistic number of files', () => {
    // Guards against an import-pattern change quietly emptying the scan, which
    // would make every assertion below pass without checking anything.
    // Naming a file that definitely offends: `offenders + allowlist > N`
    // cannot fail while the allowlist alone exceeds N, so it passed even for a
    // scanner that found nothing.
    expect(offenders).toContain('main/wsl.ts')
  })

  it('adds no new file that spawns without windowsHide', () => {
    expect(offenders.filter((path) => !ALLOWLIST.includes(path))).toEqual([])
  })

  it('carries no stale allowlist entry', () => {
    // A fixed file must leave the list, or the ratchet stops ratcheting.
    expect(ALLOWLIST.filter((path) => !offenders.includes(path))).toEqual([])
  })

  it('holds the offender count at the pin', () => {
    expect(
      offenders.length,
      `${offenders.length} files spawn without windowsHide; the pin is ${UNHIDDEN_SPAWNER_PIN}. ` +
        'Never raise the pin -- add the flag, or route the call through run-process.ts.'
    ).toBeLessThanOrEqual(UNHIDDEN_SPAWNER_PIN)
    // A pin left above reality re-opens room for the next unguarded spawn.
    expect(
      offenders.length,
      `Only ${offenders.length} files spawn without windowsHide. Lower UNHIDDEN_SPAWNER_PIN to ` +
        `${offenders.length} to keep the ground you just took.`
    ).toBeGreaterThanOrEqual(UNHIDDEN_SPAWNER_PIN)
  })
})
