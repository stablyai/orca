import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as ChildProcessModule from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { removeTreeSync } from '../../windows-transient-lock-removal'
import {
  parseWindowsCmdShim,
  resolveWindowsCmdShim
} from '@orca/process-host/windows-cmd-shim-resolution'
import { spawnProcess } from '@orca/process-host'
import {
  REAL_AGENT_BROWSER_CMD,
  REAL_CODEX_CMD,
  REAL_PNPM_CMD,
  REAL_PN_CMD,
  REAL_PNX_CMD,
  REAL_VITEST_CMD,
  REAL_VITEST_NODE_PATH,
  npmDirectShim,
  npmProgNodeShim,
  pnpmBranchedNodeShim
} from '../../../packages/process-host/src/__fixtures__/windows-cmd-shim-bodies'

const { nodeSpawn } = vi.hoisted(() => ({ nodeSpawn: vi.fn<typeof ChildProcessModule.spawn>() }))

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof ChildProcessModule>()
  return {
    ...original,
    spawn: nodeSpawn.mockImplementation(() => new original.ChildProcess())
  }
})

describe('parseWindowsCmdShim', () => {
  it('reads the npm node shim MDE flagged (codex.cmd)', () => {
    expect(parseWindowsCmdShim(REAL_CODEX_CMD)).toEqual({
      kind: 'node',
      script: 'node_modules\\@openai\\codex\\bin\\codex.js'
    })
  })

  it('reads the pnpm two-branch shim, including its NODE_PATH prepend', () => {
    expect(parseWindowsCmdShim(REAL_VITEST_CMD)).toEqual({
      kind: 'node',
      script: '..\\vitest\\vitest.mjs',
      nodePathPrefix: REAL_VITEST_NODE_PATH
    })
  })

  it('reads a pnpm branch shim with no NODE_PATH block', () => {
    expect(parseWindowsCmdShim(pnpmBranchedNodeShim('..\\x\\cli.js'))).toEqual({
      kind: 'node',
      script: '..\\x\\cli.js'
    })
  })

  it('reads the npm and pnpm shims for a bundled executable', () => {
    expect(parseWindowsCmdShim(REAL_AGENT_BROWSER_CMD)).toEqual({
      kind: 'direct',
      target: 'node_modules\\agent-browser\\bin\\agent-browser-win32-x64.exe'
    })
    expect(parseWindowsCmdShim(REAL_PNPM_CMD)).toEqual({
      kind: 'direct',
      target:
        '..\\global\\v11\\27d0-19f7df4c136-1fab7163f1a52461\\node_modules\\@pnpm\\exe\\pnpm.exe'
    })
  })

  it.each([
    ['a bare PATH command with no target to read', REAL_PN_CMD],
    ['an arbitrary batch script', '@echo off\r\nnode "%~dp0echoargs.js" %*\r\n'],
    ['a shim with extra interpreter flags', '@ECHO off\r\nnode --experimental "%~dp0a.js" %*\r\n'],
    [
      'a shim whose branches disagree about the script',
      pnpmBranchedNodeShim('..\\a.js').replace('node  "%~dp0\\..\\a.js"', 'node  "%~dp0\\..\\b.js"')
    ],
    ['a shim with anything appended after the target line', `${REAL_CODEX_CMD}echo tampered\r\n`],
    ['an unexpanded variable in the target', '@ECHO off\r\n"%~dp0%TARGET%\\a.exe" %*\r\n'],
    ['an empty file', '']
  ])('refuses %s', (_case, contents) => {
    expect(parseWindowsCmdShim(contents)).toBeNull()
  })

  it.each([
    ['a direct target', npmDirectShim('D:evil.exe')],
    ['a node script', npmProgNodeShim('D:evil.js')],
    ['a same-drive spelling', npmDirectShim('C:evil.exe')]
  ])('refuses a drive-relative path in %s', (_case, contents) => {
    // win32.resolve treats D:evil.js as drive-relative and escapes the shim directory; cmd would fail, so refuse it.
    expect(parseWindowsCmdShim(contents)).toBeNull()
  })

  it.each([
    ['%* replaced by %1, which forwards only the first argument', '%1'],
    ['%* duplicated, which forwards every argument twice', '%* %*']
  ])('refuses %s', (_case, forwarding) => {
    expect(parseWindowsCmdShim(npmProgNodeShim('cli.js').replace('%*', forwarding))).toBeNull()
  })

  it.each([
    ['a UTF-8 BOM', (body: string) => `﻿${body}`],
    ['a doubled UTF-8 BOM', (body: string) => `﻿﻿${body}`],
    ['LF-only line endings', (body: string) => body.replace(/\r\n/g, '\n')],
    ['no final newline', (body: string) => body.replace(/\r\n$/, '')],
    ['trailing whitespace on every line', (body: string) => body.replace(/\r\n/g, '  \t\r\n')],
    ['doubled blank lines', (body: string) => body.replace(/\r\n/g, '\r\n\r\n')],
    ['an all-lowercase body', (body: string) => body.toLowerCase()],
    ['an all-uppercase body', (body: string) => body.toUpperCase()]
  ])('reads the codex shim through %s', (_case, rewrite) => {
    // Generators/editors/transports vary casing and whitespace; compare the captured path against the rewritten spelling.
    const parsed = parseWindowsCmdShim(rewrite(REAL_CODEX_CMD))
    if (parsed?.kind !== 'node') {
      throw new Error('Expected a parsed Node shim')
    }
    expect(parsed.script.toLowerCase()).toBe('node_modules\\@openai\\codex\\bin\\codex.js')
  })

  it('refuses lone-CR line endings, which leave the body as one unsplit line', () => {
    expect(parseWindowsCmdShim(REAL_CODEX_CMD.replace(/\r\n/g, '\r'))).toBeNull()
  })

  it('refuses a NODE_PATH block whose branches are not a plain prepend', () => {
    const tampered = pnpmBranchedNodeShim('..\\a.js', 'C:\\p').replace(
      '"NODE_PATH=C:\\p;%NODE_PATH%"',
      '"NODE_PATH=C:\\evil;%NODE_PATH%"'
    )
    expect(parseWindowsCmdShim(tampered)).toBeNull()
  })
})

/** Filesystem resolution needs native Windows paths; parser shape recognition above runs everywhere. */
const describeOnWindows = process.platform === 'win32' ? describe : describe.skip

describeOnWindows('resolveWindowsCmdShim', () => {
  let dir: string
  let env: NodeJS.ProcessEnv

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-shim-resolve-'))
    env = { ...process.env }
    writeFileSync(join(dir, 'cli.js'), 'process.stdout.write("hi")\n')
    writeFileSync(join(dir, 'ci2.js'), '')
    writeFileSync(join(dir, 'real.exe'), '')
    writeFileSync(join(dir, 'nested.cmd'), '')
  })

  afterAll(() => {
    removeTreeSync(dir)
  })

  function write(name: string, contents: string): string {
    const path = join(dir, name)
    writeFileSync(path, contents)
    return path
  }

  it('resolves the npm node shim to node.exe plus the script', () => {
    const resolved = resolveWindowsCmdShim(write('codexish.cmd', npmProgNodeShim('cli.js')), env)
    expect(resolved?.program.toLowerCase().endsWith('node.exe')).toBe(true)
    expect(resolved?.prefixArgs).toEqual([join(dir, 'cli.js')])
    expect(resolved?.env).toBeUndefined()
  })

  it('prefers a node.exe sitting beside the shim, as the shim itself does', () => {
    const sibling = mkdtempSync(join(tmpdir(), 'orca-shim-sibling-'))
    try {
      writeFileSync(join(sibling, 'node.exe'), '')
      writeFileSync(join(sibling, 'cli.js'), '')
      const shim = join(sibling, 'a.cmd')
      writeFileSync(shim, npmProgNodeShim('cli.js'))
      expect(resolveWindowsCmdShim(shim, env)?.program).toBe(join(sibling, 'node.exe'))
    } finally {
      removeTreeSync(sibling)
    }
  })

  it('prepends the pnpm NODE_PATH the shim would have set', () => {
    const shim = write('pnpmish.cmd', pnpmBranchedNodeShim('cli.js', 'C:\\store\\a'))
    expect(resolveWindowsCmdShim(shim, { ...env, NODE_PATH: 'C:\\existing' })?.env?.NODE_PATH).toBe(
      'C:\\store\\a;C:\\existing'
    )
    expect(resolveWindowsCmdShim(shim, { ...env, NODE_PATH: undefined })?.env?.NODE_PATH).toBe(
      'C:\\store\\a'
    )
  })

  it('resolves a direct .exe target', () => {
    const shim = write('direct.cmd', npmDirectShim('real.exe'))
    expect(resolveWindowsCmdShim(shim, env)).toEqual({
      program: join(dir, 'real.exe'),
      prefixArgs: []
    })
  })

  it.each([
    ['a target that does not exist', 'missing', npmProgNodeShim('missing.js')],
    ['an extensionless direct target, which needs cmd PATHEXT search', 'pnx', REAL_PNX_CMD],
    ['a direct target that is itself a .cmd', 'nested', npmDirectShim('nested.cmd')],
    [
      'an absolute target, which the shim would not spell that way',
      'abs',
      npmDirectShim('C:\\o.exe')
    ],
    [
      'a drive-relative target that would escape the shim directory',
      'drive',
      npmDirectShim('D:o.exe')
    ],
    ['a file that is not a generated shim', 'alias', REAL_PN_CMD]
  ])('falls back for %s', (_case, name, contents) => {
    // Separate paths avoid same-size/mtime cache collisions between cases.
    expect(resolveWindowsCmdShim(write(`fallback-${name}.cmd`, contents), env)).toBeNull()
  })

  it('falls back for a relative program path', () => {
    write('relative.cmd', npmProgNodeShim('cli.js'))
    expect(resolveWindowsCmdShim('relative.cmd', env)).toBeNull()
  })

  it('honours the kill switch', () => {
    const shim = write('killswitch.cmd', npmProgNodeShim('cli.js'))
    expect(resolveWindowsCmdShim(shim, env)).not.toBeNull()
    expect(
      resolveWindowsCmdShim(shim, {
        ...env,
        ORCA_DISABLE_CMD_SHIM_RESOLUTION: '1'
      })
    ).toBeNull()
  })

  it('re-reads a shim whose mtime moved even at an identical size', () => {
    // Upgrades rewrite in place; path-only caches would retain the old entrypoint.
    const shim = write('upgraded.cmd', npmProgNodeShim('cli.js'))
    expect(resolveWindowsCmdShim(shim, env)?.prefixArgs).toEqual([join(dir, 'cli.js')])

    // Same length as the first body, so only the mtime can invalidate it.
    writeFileSync(shim, npmProgNodeShim('ci2.js'))
    const later = new Date(Date.now() + 5_000)
    utimesSync(shim, later, later)
    expect(resolveWindowsCmdShim(shim, env)?.prefixArgs).toEqual([join(dir, 'ci2.js')])
  })

  it('walks PATH once per shim directory, not once per spawn', () => {
    // Adding an earlier interpreter after first resolution proves cached PATH walks stay cached; without the cache this returns early.
    const early = mkdtempSync(join(tmpdir(), 'orca-shim-path-early-'))
    const late = mkdtempSync(join(tmpdir(), 'orca-shim-path-late-'))
    const shimDir = mkdtempSync(join(tmpdir(), 'orca-shim-path-'))
    try {
      writeFileSync(join(late, 'node.exe'), '')
      writeFileSync(join(shimDir, 'cli.js'), '')
      const shim = join(shimDir, 'walk.cmd')
      writeFileSync(shim, npmProgNodeShim('cli.js'))
      const pathEnv = { ...env, Path: undefined, PATH: `${early};${late}` }

      expect(resolveWindowsCmdShim(shim, pathEnv)?.program).toBe(join(late, 'node.exe'))

      writeFileSync(join(early, 'node.exe'), '')
      expect(resolveWindowsCmdShim(shim, pathEnv)?.program).toBe(join(late, 'node.exe'))

      // A PATH edit must miss: caching the walk must not outlive its input.
      expect(resolveWindowsCmdShim(shim, { ...pathEnv, PATH: `${early};${late};` })?.program).toBe(
        join(early, 'node.exe')
      )
    } finally {
      removeTreeSync(early)
      removeTreeSync(late)
      removeTreeSync(shimDir)
    }
  })

  it('gives up when cmd would resolve `node` to a non-.exe PATHEXT spelling', () => {
    // cmd stops at the first PATHEXT match, including .COM before .EXE; skipping it would launch the wrong binary.
    const first = mkdtempSync(join(tmpdir(), 'orca-shim-ext-first-'))
    const second = mkdtempSync(join(tmpdir(), 'orca-shim-ext-second-'))
    const shimDir = mkdtempSync(join(tmpdir(), 'orca-shim-ext-'))
    try {
      writeFileSync(join(first, 'node.com'), '')
      const nodeExe = join(second, 'node.exe')
      writeFileSync(nodeExe, '')
      writeFileSync(join(shimDir, 'cli.js'), '')
      const shim = join(shimDir, 'pathext.cmd')
      writeFileSync(shim, npmProgNodeShim('cli.js'))
      const pathEnv = { ...env, Path: undefined, PATH: `${first};${second}` }

      expect(resolveWindowsCmdShim(shim, { ...pathEnv, PATHEXT: undefined })).toBeNull()

      // PATHEXT changes both resolution and cache identity; excluding .COM makes .EXE authoritative.
      expect(resolveWindowsCmdShim(shim, { ...pathEnv, PATHEXT: '.EXE;.BAT' })?.program).toBe(
        nodeExe
      )
    } finally {
      removeTreeSync(first)
      removeTreeSync(second)
      removeTreeSync(shimDir)
    }
  })

  it('falls back to cmd.exe when the cached interpreter has been uninstalled', () => {
    // A deleted cached interpreter must fall back to cmd.exe instead of spawning ENOENT.
    const nodeDir = mkdtempSync(join(tmpdir(), 'orca-shim-gone-node-'))
    const shimDir = mkdtempSync(join(tmpdir(), 'orca-shim-gone-'))
    try {
      const nodeExe = join(nodeDir, 'node.exe')
      writeFileSync(nodeExe, '')
      writeFileSync(join(shimDir, 'cli.js'), '')
      const shim = join(shimDir, 'gone.cmd')
      writeFileSync(shim, npmProgNodeShim('cli.js'))
      const pathEnv = { ...env, Path: undefined, PATH: nodeDir }

      expect(resolveWindowsCmdShim(shim, pathEnv)?.program).toBe(nodeExe)

      rmSync(nodeExe)
      expect(resolveWindowsCmdShim(shim, pathEnv)).toBeNull()
    } finally {
      removeTreeSync(nodeDir)
      removeTreeSync(shimDir)
    }
  })

  it('keeps cmd.exe out of the spawn for a recognised shim', () => {
    spawnProcess({
      program: write('spawned.cmd', npmProgNodeShim('cli.js')),
      args: ['a b', 'c"d'],
      env
    })
    // Node owns CommandLineToArgvW quoting once the cmd hop is removed.
    expect(nodeSpawn).toHaveBeenLastCalledWith(
      expect.stringMatching(/node\.exe$/i),
      [join(dir, 'cli.js'), 'a b', 'c"d'],
      expect.objectContaining({ windowsVerbatimArguments: undefined })
    )
  })

  it('clears a caller-set windowsVerbatimArguments on the resolved path', () => {
    // No verbatim line exists on this path; honoring the flag would join spaced arguments without quotes.
    spawnProcess({
      program: write('verbatim.cmd', npmProgNodeShim('cli.js')),
      args: ['a b'],
      env,
      windowsVerbatimArguments: true
    })
    expect(nodeSpawn).toHaveBeenLastCalledWith(
      expect.stringMatching(/node\.exe$/i),
      [join(dir, 'cli.js'), 'a b'],
      expect.objectContaining({ windowsVerbatimArguments: undefined })
    )
  })

  it('still routes an unrecognised .cmd through cmd.exe', () => {
    spawnProcess({
      program: write('plain.cmd', REAL_PN_CMD),
      args: ['x'],
      env: { ComSpec: 'C:\\W\\cmd.exe' }
    })
    expect(nodeSpawn).toHaveBeenLastCalledWith(
      'C:\\W\\cmd.exe',
      [expect.stringContaining('/d /v:off /s /c')],
      expect.objectContaining({ windowsVerbatimArguments: true })
    )
  })
})
