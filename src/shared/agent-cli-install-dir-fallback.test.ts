import { delimiter, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { detectCommandsInInstallDirs } from './local-agent-install-dir-detection'
import {
  getVersionManagerBinPaths,
  resolveCliCommand,
  resolveCliCommands
} from './node-cli-command-resolution'
import { buildPosixFallbackPathPrelude } from './posix-version-manager-bin-dirs'
import { getSystemCliInstallDirectories } from './system-cli-install-dirs'

/**
 * The install-dir fallback answers "is this agent CLI installed?" whenever the
 * login-shell PATH probe does not land. Homebrew, npm's default global prefix
 * and opencode's own installer are absolute paths, so they cannot be staged
 * under a temp home -- hence a synthetic fs rather than a fixture tree.
 *
 * Every staged path goes through `join`, because the lookup builds candidates
 * with the host's `join`: a literal `/opt/homebrew/bin/codex` would never match
 * on a Windows dev machine.
 */
const fsFixture = vi.hoisted(() => ({ executables: new Set<string>() }))

const MOCK_HOME = '/home/tester'

vi.mock('node:os', () => ({ homedir: () => MOCK_HOME }))

vi.mock('node:fs', () => ({
  constants: { X_OK: 1 },
  statSync: (target: string) => {
    if (!fsFixture.executables.has(target)) {
      throw new Error(`ENOENT: ${target}`)
    }
    return { isFile: () => true }
  },
  accessSync: (target: string) => {
    if (!fsFixture.executables.has(target)) {
      throw new Error(`EACCES: ${target}`)
    }
  },
  // No nvm install in any of these cases; the nvm walk is covered by nvm-default-alias.test.ts.
  existsSync: () => false,
  readdirSync: () => {
    throw new Error('ENOENT')
  },
  readFileSync: () => {
    throw new Error('ENOENT')
  }
}))

// The PATH a Finder/Dock-launched macOS app inherits with no login shell.
const GUI_LAUNCH_PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(delimiter)

function stage(...paths: string[]): void {
  for (const path of paths) {
    fsFixture.executables.add(path)
  }
}

function resolveAll(
  commands: string[],
  options: { platform: NodeJS.Platform; homePath: string }
): Record<string, string> {
  return Object.fromEntries(
    resolveCliCommands(commands, { ...options, pathEnv: GUI_LAUNCH_PATH })
  ) as Record<string, string>
}

beforeEach(() => {
  fsFixture.executables.clear()
  // Why: the no-options entry point reads the ambient PATH, where a dev box's
  // real /usr/local/bin would answer before the fallback ever runs.
  vi.stubEnv('PATH', GUI_LAUNCH_PATH)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('agent CLI install-dir fallback', () => {
  it('finds macOS CLIs installed outside a version manager', () => {
    const home = '/Users/tester'
    stage(
      join(home, '.local', 'bin', 'claude'),
      join('/opt/homebrew/bin', 'codex'),
      join('/usr/local/bin', 'cursor-agent'),
      join(home, '.opencode', 'bin', 'opencode')
    )
    expect(
      resolveAll(['claude', 'codex', 'cursor-agent', 'opencode'], {
        platform: 'darwin',
        homePath: home
      })
    ).toEqual({
      claude: join(home, '.local', 'bin', 'claude'),
      codex: join('/opt/homebrew/bin', 'codex'),
      'cursor-agent': join('/usr/local/bin', 'cursor-agent'),
      opencode: join(home, '.opencode', 'bin', 'opencode')
    })
  })

  it('finds Linux CLIs in Linuxbrew, snap and nix prefixes, not the macOS brew prefix', () => {
    const home = '/home/tester'
    stage(
      join('/home/linuxbrew/.linuxbrew/bin', 'codex'),
      join('/snap/bin', 'cursor-agent'),
      join(home, '.nix-profile', 'bin', 'opencode'),
      join('/opt/homebrew/bin', 'claude')
    )
    expect(
      resolveAll(['codex', 'cursor-agent', 'opencode', 'claude'], {
        platform: 'linux',
        homePath: home
      })
    ).toEqual({
      codex: join('/home/linuxbrew/.linuxbrew/bin', 'codex'),
      'cursor-agent': join('/snap/bin', 'cursor-agent'),
      opencode: join(home, '.nix-profile', 'bin', 'opencode'),
      // Why unresolved: /opt/homebrew is an Apple Silicon prefix; Linuxbrew uses another.
      claude: 'claude'
    })
  })

  it('leaves the win32 branch on its own install dirs', () => {
    const home = 'C:/Users/tester'
    stage(join(home, 'AppData', 'Roaming', 'npm', 'codex.cmd'), join('/usr/local/bin', 'claude'))
    expect(resolveAll(['codex', 'claude'], { platform: 'win32', homePath: home })).toEqual({
      codex: join(home, 'AppData', 'Roaming', 'npm', 'codex.cmd'),
      claude: 'claude'
    })
  })

  // Why pinned: patchPackagedProcessPath seeds these onto PATH in this order and
  // the POSIX guest prelude appends them in it, so a divergence here would spawn
  // a different binary than the packaged PATH scan for the same install.
  it('ranks system install dirs in the same order as the PATH seed', () => {
    const home = '/home/tester'
    const dirs = [
      '/usr/local/bin',
      '/snap/bin',
      '/home/linuxbrew/.linuxbrew/bin',
      '/nix/var/nix/profiles/default/bin',
      join(home, '.nix-profile', 'bin'),
      join(home, '.opencode', 'bin'),
      join(home, '.vite-plus', 'bin')
    ]
    stage(...dirs.map((dir) => join(dir, 'opencode')))
    for (const expected of dirs) {
      expect(resolveAll(['opencode'], { platform: 'linux', homePath: home })).toEqual({
        opencode: join(expected, 'opencode')
      })
      fsFixture.executables.delete(join(expected, 'opencode'))
    }
  })

  // Why both resolvers and both platforms: resolveCliCommand is what every
  // spawn site (codex login, app-server, session-index heal) calls, and its
  // list was once spelled separately from resolveCliCommands'. A same-named
  // binary in /usr/local/bin must never shadow the one a version manager owns.
  describe.each([
    { platform: 'darwin' as const, home: '/Users/tester', systemDir: '/opt/homebrew/bin' },
    {
      platform: 'linux' as const,
      home: '/home/tester',
      systemDir: '/home/linuxbrew/.linuxbrew/bin'
    }
  ])('$platform: system dirs stay last', ({ platform, home, systemDir }) => {
    it('lets a version-manager install outrank a system one', () => {
      const managed = join(home, '.volta', 'bin', 'codex')
      stage(managed, join(systemDir, 'codex'), join('/usr/local/bin', 'codex'))
      expect(resolveCliCommand('codex', { platform, homePath: home })).toBe(managed)
      expect(resolveAll(['codex'], { platform, homePath: home })).toEqual({ codex: managed })
    })

    it('lets an npm --user (~/.local/bin) install outrank a system one', () => {
      const managed = join(home, '.local', 'bin', 'codex')
      stage(managed, join(systemDir, 'codex'))
      expect(resolveCliCommand('codex', { platform, homePath: home })).toBe(managed)
      expect(resolveAll(['codex'], { platform, homePath: home })).toEqual({ codex: managed })
    })

    it('lets a copy already on PATH outrank every install dir', () => {
      const onPath = join('/custom/bin', 'codex')
      const pathEnv = [GUI_LAUNCH_PATH, '/custom/bin'].join(delimiter)
      stage(onPath, join(home, '.volta', 'bin', 'codex'), join(systemDir, 'codex'))
      expect(resolveCliCommand('codex', { platform, homePath: home, pathEnv })).toBe(onPath)
      expect(resolveCliCommands(['codex'], { platform, homePath: home, pathEnv })).toEqual(
        new Map([['codex', onPath]])
      )
    })
  })

  // Why this guard: getVersionManagerBinPaths is PREPENDED onto PATH by
  // patchPackagedProcessPath and the CLI's addAgentNodePaths, so a system dir
  // leaking into it would re-rank binaries the user already has (#18234).
  it('keeps system install dirs out of the PATH seed list', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const home = platform === 'darwin' ? '/Users/tester' : '/home/tester'
      const seeded = getVersionManagerBinPaths({ platform, homePath: home })
      // Spelled out, not derived from the list under test: a guard that iterates
      // getSystemCliInstallDirectories passes vacuously if that list is emptied
      // into getBaseVersionManagerDirectories, which is the leak it guards.
      for (const directory of [
        '/opt/homebrew/bin',
        '/usr/local/bin',
        '/snap/bin',
        '/home/linuxbrew/.linuxbrew/bin',
        '/nix/var/nix/profiles/default/bin',
        join(home, '.nix-profile', 'bin'),
        join(home, '.opencode', 'bin'),
        join(home, '.vite-plus', 'bin')
      ]) {
        expect(seeded).not.toContain(directory)
      }
    }
  })

  // Why through this entry point: it is what the `orca` CLI's agent detection
  // calls, and the "absolute path means installed" contract lives here.
  it.skipIf(process.platform === 'win32')(
    'reports a system-installed CLI as detected, not just resolved',
    () => {
      stage(
        join('/usr/local/bin', 'codex'),
        join(MOCK_HOME, '.opencode', 'bin', 'opencode'),
        // Why pi: it is a probed detect command on every runtime (tui-agent-config.ts,
        // no detectUnsupportedRuntimes) and its installer defaults to ~/.vite-plus/bin,
        // the second dir #829 named and seeded alongside ~/.opencode/bin.
        join(MOCK_HOME, '.vite-plus', 'bin', 'pi')
      )
      // All three come from the fallback: the stubbed PATH holds no system dir.
      expect(detectCommandsInInstallDirs(['codex', 'opencode', 'pi', 'cursor-agent'])).toEqual(
        new Set(['codex', 'opencode', 'pi'])
      )
    }
  )

  it('carries the system install dirs into the POSIX guest fallback prelude', () => {
    const prelude = buildPosixFallbackPathPrelude()
    const systemDirs = [
      '"/usr/local/bin"',
      '"/snap/bin"',
      '"/home/linuxbrew/.linuxbrew/bin"',
      '"/nix/var/nix/profiles/default/bin"',
      '"$HOME/.nix-profile/bin"',
      '"$HOME/.opencode/bin"',
      '"$HOME/.vite-plus/bin"'
    ]
    const offsets = systemDirs.map((dir) => prelude.indexOf(dir))
    expect(offsets.every((offset) => offset >= 0)).toBe(true)
    expect([...offsets].sort((a, b) => a - b)).toEqual(offsets)
    // Why after: the guest prelude appends, so a version manager must still win.
    expect(prelude.indexOf('.nvm/versions/node/*/bin')).toBeLessThan(offsets[0])
    // Why absent: a WSL guest is Linux, so /opt/homebrew is never its brew prefix.
    expect(prelude).not.toContain('/opt/homebrew')
  })

  // Why derived: the native and guest lists drifted apart once by hand. Every
  // version-manager dir the native resolver knows must precede the guest's
  // first system dir, and the guest's system block must be the native one.
  it('keeps the WSL guest prelude in step with the native Linux lists', () => {
    const prelude = buildPosixFallbackPathPrelude()
    const asGuest = (dir: string): string => `"${dir.split('\\').join('/')}"`
    const systemDirs = getSystemCliInstallDirectories('linux', '$HOME').map(asGuest)
    const firstSystemOffset = prelude.indexOf(systemDirs[0])
    expect(firstSystemOffset).toBeGreaterThan(0)
    for (const dir of getVersionManagerBinPaths({ platform: 'linux', homePath: '$HOME' })) {
      const offset = prelude.indexOf(asGuest(dir))
      expect(offset, dir).toBeGreaterThanOrEqual(0)
      expect(offset, dir).toBeLessThan(firstSystemOffset)
    }
    const systemOffsets = systemDirs.map((dir) => prelude.indexOf(dir))
    expect(systemOffsets.every((offset) => offset >= firstSystemOffset)).toBe(true)
    expect([...systemOffsets].sort((a, b) => a - b)).toEqual(systemOffsets)
  })
})
