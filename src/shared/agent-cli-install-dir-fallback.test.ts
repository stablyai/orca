import { delimiter, join } from 'node:path'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import type * as NodeOs from 'node:os'
import { runProcess } from '@orca/process-host'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { detectCommandsInInstallDirs } from './local-agent-install-dir-detection'
import {
  getVersionManagerBinPaths,
  resolveCliCommand,
  resolveCliCommands
} from './node-cli-command-resolution'
import { buildPosixFallbackPathPrelude } from './posix-version-manager-bin-dirs'

/** Use synthetic fs for absolute install prefixes that cannot fit a temp home. Build every path with host join so Windows fixtures match production candidates. */
const fsFixture = vi.hoisted(() => ({ executables: new Set<string>() }))

const MOCK_HOME = '/home/tester'

vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeOs>()),
  homedir: () => MOCK_HOME
}))

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
  return Object.fromEntries(resolveCliCommands(commands, { ...options, pathEnv: GUI_LAUNCH_PATH }))
}

beforeEach(() => {
  fsFixture.executables.clear()
  // Stub ambient PATH or real developer binaries can answer before fallback.
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
      join('/opt/local/bin', 'gemini'),
      join(home, '.opencode', 'bin', 'opencode')
    )
    expect(
      resolveAll(['claude', 'codex', 'cursor-agent', 'gemini', 'opencode'], {
        platform: 'darwin',
        homePath: home
      })
    ).toEqual({
      claude: join(home, '.local', 'bin', 'claude'),
      codex: join('/opt/homebrew/bin', 'codex'),
      'cursor-agent': join('/usr/local/bin', 'cursor-agent'),
      gemini: join('/opt/local/bin', 'gemini'),
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
      // Homebrew's macOS prefix is not Linuxbrew's.
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

  // Match packaged PATH seeding and guest prelude order so all resolvers select the same binary.
  it('ranks system install dirs in the same order as the PATH seed', () => {
    const home = '/home/tester'
    const dirs = [
      '/usr/local/bin',
      '/snap/bin',
      '/home/linuxbrew/.linuxbrew/bin',
      '/nix/var/nix/profiles/default/bin',
      join(home, '.nix-profile', 'bin'),
      join(home, '.opencode', 'bin'),
      join(home, '.vite-plus', 'bin'),
      join(home, '.grok', 'bin')
    ]
    stage(...dirs.map((dir) => join(dir, 'opencode')))
    for (const expected of dirs) {
      expect(resolveAll(['opencode'], { platform: 'linux', homePath: home })).toEqual({
        opencode: join(expected, 'opencode')
      })
      fsFixture.executables.delete(join(expected, 'opencode'))
    }
  })

  // Both resolver entrypoints must prefer version-manager binaries over same-named system installs.
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

  // System dirs must not leak into the prepended version-manager seed and reorder user binaries (#18234).
  it('keeps system install dirs out of the PATH seed list', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const home = platform === 'darwin' ? '/Users/tester' : '/home/tester'
      const seeded = getVersionManagerBinPaths({ platform, homePath: home })
      // List system paths independently; deriving them from production would hide accidental removal.
      for (const directory of [
        '/opt/homebrew/bin',
        '/usr/local/bin',
        '/opt/local/bin',
        '/snap/bin',
        '/home/linuxbrew/.linuxbrew/bin',
        '/nix/var/nix/profiles/default/bin',
        join(home, '.nix-profile', 'bin'),
        join(home, '.opencode', 'bin'),
        join(home, '.vite-plus', 'bin'),
        join(home, '.grok', 'bin')
      ]) {
        expect(seeded).not.toContain(directory)
      }
    }
  })

  // Verify the orca CLI detection entrypoint's absolute-path installation contract.
  it.skipIf(process.platform === 'win32')(
    'reports a system-installed CLI as detected, not just resolved',
    () => {
      stage(
        join('/usr/local/bin', 'codex'),
        join(MOCK_HOME, '.opencode', 'bin', 'opencode'),
        // Pi defaults to ~/.vite-plus/bin and is probed on every runtime (#829).
        join(MOCK_HOME, '.vite-plus', 'bin', 'pi'),
        // Grok's installer defaults to ~/.grok/bin (#17590).
        join(MOCK_HOME, '.grok', 'bin', 'grok')
      )
      // All come from the fallback: the stubbed PATH holds no system dir.
      expect(
        detectCommandsInInstallDirs(['codex', 'opencode', 'pi', 'grok', 'cursor-agent'])
      ).toEqual(new Set(['codex', 'opencode', 'pi', 'grok']))
    }
  )

  // WSL 2.7.10 repro: ambient PATH found a /mnt/c npm shim after filtered lookup rejected it.
  it.skipIf(process.platform === 'win32')(
    'searches the PATH detection searched, not the ambient one',
    () => {
      const shimDir = '/mnt/c/Users/u/AppData/Roaming/npm'
      stage(join(shimDir, 'codex'))
      vi.stubEnv('PATH', [GUI_LAUNCH_PATH, shimDir].join(delimiter))
      expect(detectCommandsInInstallDirs(['codex'])).toEqual(new Set(['codex']))
      expect(detectCommandsInInstallDirs(['codex'], GUI_LAUNCH_PATH)).toEqual(new Set())
    }
  )

  it.skipIf(process.platform === 'win32')(
    'keeps login PATH first, then resolves nvm and installer fallbacks with spaces in HOME',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'orca-guest-fallback-'))
      const home = join(root, 'home with space')
      const login = join(root, 'login-bin')
      const directories = [
        login,
        join(home, '.nvm', 'versions', 'node', 'v24.0.0', 'bin'),
        join(home, '.opencode', 'bin'),
        join(home, '.vite-plus', 'bin'),
        join(home, '.grok', 'bin')
      ]
      const command = 'orca-fallback-fixture'
      try {
        for (const directory of directories) {
          await mkdir(directory, { recursive: true })
          await writeFile(join(directory, command), '#!/bin/sh\n', { mode: 0o755 })
        }
        for (const directory of directories) {
          const result = await runProcess({
            program: '/bin/sh',
            args: ['-c', `${buildPosixFallbackPathPrelude()}\ncommand -v ${command}`],
            env: { HOME: home, PATH: login, ORCA_BACKGROUND_LAUNCH: '1' },
            timeoutMs: 10_000,
            terminationBarrier: true
          })
          expect(result.code, result.stderr).toBe(0)
          expect(result.timedOut).toBe(false)
          expect(result.stdout.trim()).toBe(join(directory, command))
          await rm(join(directory, command))
        }
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  )
})
