import { execFileSync } from 'node:child_process'
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildPosixCommandPathLookupScript } from './posix-command-path-lookup'
import { buildWslCapturedLoginShellCommand, buildWslExecArgs } from './wsl-login-shell-command'

type ShellCase = {
  name: string
  path: string | null
}

const isWindows = process.platform === 'win32'
const WSL_TEST_COMMAND_TIMEOUT_MS = 10_000
let wslShAvailable: boolean | null = null
let writableMntRoot: string | null | undefined
const shellCases: ShellCase[] = [
  { name: 'sh', path: executablePath(['/bin/sh']) },
  { name: 'bash', path: executablePath(['/bin/bash', '/usr/bin/bash']) },
  { name: 'zsh', path: executablePath(['/bin/zsh', '/usr/bin/zsh']) },
  { name: 'dash', path: executablePath(['/bin/dash', '/usr/bin/dash']) }
]

describe('buildPosixCommandPathLookupScript', () => {
  for (const shell of shellCases) {
    it.skipIf(isWindows || shell.path === null)(
      `resolves without mutating alias and function masks in ${shell.name}`,
      () => {
        const commandName = basename(process.execPath)
        const script = [
          `${commandName}() { printf '%s\\n' masked-function; }`,
          `alias ${commandName}='printf "%s\\n" masked-alias'`,
          buildPosixCommandPathLookupScript({ kind: 'literal', value: commandName }),
          `printf '%s\\n' "$resolved"`,
          `alias ${commandName} >/dev/null`,
          `unalias ${commandName}`,
          `${commandName}`
        ].join('\n')

        const resolved = execFileSync(shell.path!, ['-c', script], {
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}`
          }
        })
          .trim()
          .split('\n')

        expect(isAbsolute(resolved[0])).toBe(true)
        expect(realpathSync(resolved[0])).toBe(realpathSync(process.execPath))
        expect(resolved[1]).toBe('masked-function')
      }
    )
  }

  it.skipIf(isWindows || executablePath(['/bin/sh']) === null)(
    'resolves a command held in a validated shell variable',
    () => {
      const commandName = basename(process.execPath)
      const script = [
        `cmd='${commandName}'`,
        `${commandName}() { printf '%s\\n' masked-function; }`,
        `alias ${commandName}='printf "%s\\n" masked-alias'`,
        buildPosixCommandPathLookupScript({ kind: 'shell-variable', name: 'cmd' }),
        `printf '%s\\n' "$resolved"`
      ].join('\n')

      const resolved = execFileSync('/bin/sh', ['-c', script], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}`
        }
      }).trim()

      expect(isAbsolute(resolved)).toBe(true)
      expect(realpathSync(resolved)).toBe(realpathSync(process.execPath))
    }
  )

  it.skipIf(isWindows || executablePath(['/bin/bash', '/usr/bin/bash']) === null)(
    'resolves past a readonly bash function mask',
    () => {
      const commandName = basename(process.execPath)
      const script = [
        `${commandName}() { printf '%s\\n' masked-function; }`,
        `readonly -f ${commandName}`,
        buildPosixCommandPathLookupScript({ kind: 'literal', value: commandName }),
        `printf '%s\\n' "$resolved"`
      ].join('\n')

      const resolved = execFileSync(
        executablePath(['/bin/bash', '/usr/bin/bash'])!,
        ['-c', script],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}`
          }
        }
      ).trim()

      expect(realpathSync(resolved)).toBe(realpathSync(process.execPath))
    }
  )

  it.skipIf(isWindows || executablePath(['/bin/sh']) === null)(
    'prefers the first external executable even when its name is a shell builtin',
    () => {
      withExecutableFixture('printf', (directory, executable, root) => {
        const secondDirectory = join(root, 'second-bin')
        const secondExecutable = join(secondDirectory, 'printf')
        mkdirSync(secondDirectory)
        writeFileSync(secondExecutable, '#!/bin/sh\nexit 0\n')
        chmodSync(secondExecutable, 0o755)
        const script = [
          buildPosixCommandPathLookupScript({ kind: 'literal', value: 'printf' }),
          `printf '%s\\n' "$resolved"`
        ].join('\n')
        const resolved = execFileSync('/bin/sh', ['-c', script], {
          encoding: 'utf8',
          env: { ...process.env, PATH: `${directory}:${secondDirectory}` }
        }).trim()

        expectResolvedExecutable(resolved, executable)
      })
    }
  )

  it.skipIf(isWindows || executablePath(['/bin/sh']) === null)(
    'makes relative and trailing-empty PATH matches absolute',
    () => {
      withExecutableFixture('relative-agent', (directory, executable, root) => {
        const relativeDirectory = basename(directory)
        const script = [
          buildPosixCommandPathLookupScript({ kind: 'literal', value: 'relative-agent' }),
          `printf '%s\\n' "$resolved"`
        ].join('\n')
        const relativeResolved = execFileSync('/bin/sh', ['-c', script], {
          cwd: root,
          encoding: 'utf8',
          env: { ...process.env, PATH: `${relativeDirectory}:` }
        }).trim()
        const trailingResolved = execFileSync('/bin/sh', ['-c', script], {
          cwd: directory,
          encoding: 'utf8',
          env: { ...process.env, PATH: '/missing:' }
        }).trim()
        const emptyResolved = execFileSync('/bin/sh', ['-c', script], {
          cwd: directory,
          encoding: 'utf8',
          env: { ...process.env, PATH: ':/missing' }
        }).trim()

        expectResolvedExecutable(relativeResolved, executable)
        expectResolvedExecutable(trailingResolved, executable)
        expectResolvedExecutable(emptyResolved, executable)
      })
    }
  )

  it.skipIf(isWindows || executablePath(['/bin/sh']) === null)(
    'handles leading-dash names and explicit relative paths',
    () => {
      withExecutableFixture('-agent', (directory, executable) => {
        const script = [
          buildPosixCommandPathLookupScript({ kind: 'shell-variable', name: 'cmd' }),
          `printf '%s\\n' "$resolved"`,
          buildPosixCommandPathLookupScript({ kind: 'literal', value: './-agent' }),
          `printf '%s\\n' "$resolved"`
        ].join('\n')
        const output = execFileSync('/bin/sh', ['-c', script], {
          cwd: directory,
          encoding: 'utf8',
          env: { ...process.env, PATH: directory, cmd: '-agent' }
        })
          .trim()
          .split('\n')

        expectResolvedExecutable(output[0], executable)
        expectResolvedExecutable(output[1], executable)
      })
    }
  )

  it.skipIf(isWindows || executablePath(['/bin/sh']) === null)(
    'keeps set -e callers running when the command is absent',
    () => {
      const script = [
        'set -e',
        buildPosixCommandPathLookupScript({
          kind: 'literal',
          value: '__orca_missing_command_path_lookup__'
        }),
        `printf '%s\\n' survived`
      ].join('\n')

      expect(execFileSync('/bin/sh', ['-c', script], { encoding: 'utf8' }).trim()).toBe('survived')
    }
  )

  it.each(['', '$cmd', 'cmd-name', 'cmd; echo injected'])(
    'rejects an unsafe shell variable name: %s',
    (name) => {
      expect(() => buildPosixCommandPathLookupScript({ kind: 'shell-variable', name })).toThrow(
        'Invalid shell variable name'
      )
    }
  )

  it('quotes literal targets before assigning them in the generated shell fragment', () => {
    const script = buildPosixCommandPathLookupScript({
      kind: 'literal',
      value: "agent'; echo injected; '"
    })

    expect(script).toContain(`_orca_lookup_command='agent'\\''; echo injected; '\\'''`)
  })

  it('emits the drive-letter /mnt guard only when skipWindowsMountDirs is set', () => {
    const withSkip = buildPosixCommandPathLookupScript(
      { kind: 'literal', value: 'agent' },
      { skipWindowsMountDirs: true }
    )
    const withoutSkip = buildPosixCommandPathLookupScript({ kind: 'literal', value: 'agent' })

    expect(withSkip).toContain('case "$_orca_lookup_component" in')
    expect(withSkip).toContain('/mnt/[A-Za-z]|/mnt/[A-Za-z]/*)')
    expect(withSkip).not.toContain('/mnt|/mnt/*)')
    expect(withoutSkip).not.toContain('/mnt/[A-Za-z]|/mnt/[A-Za-z]/*)')
  })

  it.skipIf(executablePath(['/bin/sh']) === null)(
    'the /mnt guard matches only single-letter drive mounts, not multi-letter /mnt paths',
    () => {
      const guard = [
        'case "$_orca_lookup_component" in',
        '  /mnt/[A-Za-z]|/mnt/[A-Za-z]/*)',
        '    printf matched ;;',
        '  *)',
        '    printf searchable ;;',
        'esac'
      ].join('\n')
      const execGuard = (component: string): string =>
        execFileSync('/bin/sh', ['-c', `_orca_lookup_component='${component}'; ${guard}`], {
          encoding: 'utf8'
        })
          .trim()
          .split('\n')
          .at(-1) ?? ''

      expect(execGuard('/mnt/c')).toBe('matched')
      expect(execGuard('/mnt/c/Windows/System32')).toBe('matched')
      expect(execGuard('/mnt/w')).toBe('matched')
      // Multi-letter /mnt mounts (custom Linux mounts, WSL internals like
      // /mnt/wsl and /mnt/wslg) stay searchable.
      expect(execGuard('/mnt/wsl')).toBe('searchable')
      expect(execGuard('/mnt/data')).toBe('searchable')
      expect(execGuard('/mnt/backup/bin')).toBe('searchable')
      expect(execGuard('/mnt')).toBe('searchable')
    }
  )

  it.skipIf(executablePath(['/bin/sh']) === null || getWritableMntRoot() === null)(
    'skips Windows-drive /mnt PATH components when skipWindowsMountDirs is set',
    () => {
      const mntRoot = getWritableMntRoot()!
      const fixtureDir = join(mntRoot, `orca-mnt-lookup-${process.pid}`)
      const mntExecutable = join(fixtureDir, 'mnt-agent')
      const nativeDir = mkdtempSync(join(tmpdir(), 'orca-mnt-native-'))
      const nativeExecutable = join(nativeDir, 'native-agent')
      const buildScript = (name: string, skip: boolean): string =>
        [
          buildPosixCommandPathLookupScript(
            { kind: 'literal', value: name },
            skip ? { skipWindowsMountDirs: true } : {}
          ),
          `printf '%s\\n' "$resolved"`
        ].join('\n')
      try {
        mkdirSync(fixtureDir)
        writeFileSync(mntExecutable, '#!/bin/sh\nexit 0\n')
        chmodSync(mntExecutable, 0o755)
        writeFileSync(nativeExecutable, '#!/bin/sh\nexit 0\n')
        chmodSync(nativeExecutable, 0o755)
        const path = `${fixtureDir}:${nativeDir}`

        // Without the skip the /mnt component wins the lookup.
        const foundWithMnt = execFileSync('/bin/sh', ['-c', buildScript('mnt-agent', false)], {
          encoding: 'utf8',
          env: { ...process.env, PATH: path }
        }).trim()
        expectResolvedExecutable(foundWithMnt, mntExecutable)

        // With the skip the /mnt component is ignored.
        const skippedMnt = execFileSync('/bin/sh', ['-c', buildScript('mnt-agent', true)], {
          encoding: 'utf8',
          env: { ...process.env, PATH: path }
        }).trim()
        expect(skippedMnt).toBe('')

        // Native-path agents still resolve with the skip on.
        const nativeWithSkip = execFileSync('/bin/sh', ['-c', buildScript('native-agent', true)], {
          encoding: 'utf8',
          env: { ...process.env, PATH: path }
        }).trim()
        expectResolvedExecutable(nativeWithSkip, nativeExecutable)
      } finally {
        rmSync(fixtureDir, { force: true, recursive: true })
        rmSync(nativeDir, { force: true, recursive: true })
      }
    }
  )

  it.skipIf(!canRunWslSh())(
    'resolves through the Windows-to-WSL login-shell boundary with inline masks',
    () => {
      const lookup = buildPosixCommandPathLookupScript({ kind: 'literal', value: 'sh' })
      // Why the captured form: an interactive login shell also prints the distro's
      // rc/motd to stdout, which would land in front of the resolved path.
      const captured = buildWslCapturedLoginShellCommand(
        [
          `sh() { printf '%s\\n' masked-function; }`,
          `alias sh='printf masked-alias'`,
          lookup,
          `printf '%s' "$resolved"`
        ].join('\n')
      )
      const stdout = execFileSync(
        'wsl.exe',
        buildWslExecArgs(undefined, ['sh', '-lc', captured.command]),
        { encoding: 'utf8', timeout: WSL_TEST_COMMAND_TIMEOUT_MS }
      )

      expect(captured.readStdout(stdout)?.trim()).toMatch(/^\/.+\/sh$/)
    },
    30_000
  )
})

function expectResolvedExecutable(resolved: string, executable: string): void {
  expect(isAbsolute(resolved)).toBe(true)
  expect(realpathSync(resolved)).toBe(realpathSync(executable))
}

function canRunWslSh(): boolean {
  if (!isWindows) {
    return false
  }
  if (wslShAvailable !== null) {
    return wslShAvailable
  }
  try {
    execFileSync('wsl.exe', ['--exec', 'sh', '-lc', 'true'], {
      timeout: WSL_TEST_COMMAND_TIMEOUT_MS
    })
    wslShAvailable = true
  } catch {
    wslShAvailable = false
  }
  return wslShAvailable
}

/** First writable /mnt/<drive> root, or null when none exists (non-WSL hosts, CI). */
function getWritableMntRoot(): string | null {
  if (isWindows || writableMntRoot !== undefined) {
    return writableMntRoot ?? null
  }
  for (const root of ['/mnt/c/Users/Public', '/mnt/c/Windows/Temp']) {
    try {
      const probe = join(root, `.orca-wsl-write-${process.pid}`)
      writeFileSync(probe, '')
      rmSync(probe, { force: true })
      writableMntRoot = root
      return root
    } catch {
      // Try the next candidate; none writable means the behavioral /mnt test skips.
    }
  }
  writableMntRoot = null
  return null
}

function withExecutableFixture(
  name: string,
  run: (directory: string, executable: string, root: string) => void
): void {
  const root = mkdtempSync(join(tmpdir(), 'orca-path-lookup-'))
  const directory = join(root, 'bin')
  const executable = join(directory, name)
  try {
    mkdirSync(directory)
    writeFileSync(executable, '#!/bin/sh\nexit 0\n')
    chmodSync(executable, 0o755)
    run(directory, executable, root)
  } finally {
    rmSync(root, { force: true, recursive: true })
  }
}

function executablePath(candidates: readonly string[]): string | null {
  if (isWindows) {
    return null
  }
  for (const candidate of candidates) {
    if (!existsSync(candidate)) {
      continue
    }
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // Keep checking alternate standard locations when this entry is not executable.
    }
  }
  return null
}
