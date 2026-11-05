import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type * as NodeFs from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveCliCommandAsync } from './node-cli-command-async-resolution'
import { resolveCliCommand } from './node-cli-command-resolution'

const syncFs = vi.hoisted(() => ({ forbidden: false, calls: new Array<string>() }))

// Throws from every sync read a CLI lookup could make while forbidden, proving the async lookup makes none.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  const guard =
    <A extends unknown[], R>(name: string, read: (...args: A) => R) =>
    (...args: A): R => {
      if (syncFs.forbidden) {
        syncFs.calls.push(name)
        throw new Error(`sync fs call: ${name}`)
      }
      return read(...args)
    }
  return {
    ...actual,
    accessSync: guard('accessSync', actual.accessSync),
    existsSync: guard('existsSync', actual.existsSync),
    lstatSync: guard('lstatSync', actual.lstatSync),
    readdirSync: guard('readdirSync', actual.readdirSync),
    readFileSync: guard('readFileSync', actual.readFileSync),
    realpathSync: guard('realpathSync', actual.realpathSync),
    statSync: guard('statSync', actual.statSync)
  }
})

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-cli-resolve-async-'))
})

afterEach(() => {
  syncFs.forbidden = false
  syncFs.calls = []
  rmSync(root, { recursive: true, force: true })
})

function stage(...relative: string[]): void {
  for (const path of relative) {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), '')
  }
}

// Windows' spawn recheck uses the async resolver; it must pick what panes' sync resolver picks.
// platform: 'win32' skips the X_OK check, so these run on any host.
describe('resolveCliCommandAsync agrees with resolveCliCommand on Windows', () => {
  const options = (...dirs: string[]) => ({
    pathEnv: dirs.map((dir) => join(root, dir)).join(delimiter),
    homePath: join(root, 'home'),
    platform: 'win32' as const
  })

  it.each([
    {
      name: 'the .cmd shim beats .exe and .bat in one dir',
      files: ['a/codex.exe', 'a/codex.bat', 'a/codex.cmd'],
      expected: 'a/codex.cmd'
    },
    { name: '.exe beats .bat', files: ['a/codex.bat', 'a/codex.exe'], expected: 'a/codex.exe' },
    {
      name: 'an earlier PATH dir beats a better extension later',
      files: ['a/codex.bat', 'b/codex.cmd'],
      expected: 'a/codex.bat'
    },
    {
      name: 'a PATH miss falls back to the npm global dir',
      files: ['home/AppData/Roaming/npm/codex.cmd'],
      expected: 'home/AppData/Roaming/npm/codex.cmd'
    },
    {
      name: 'a PATH copy beats an install-dir copy',
      files: ['home/AppData/Roaming/npm/codex.cmd', 'b/codex.exe'],
      expected: 'b/codex.exe'
    },
    {
      name: "nvm's default alias outranks a newer nvm install",
      files: [
        'home/.nvm/alias/default',
        'home/.nvm/versions/node/v22.0.0/bin/codex.cmd',
        'home/.nvm/versions/node/v20.1.0/bin/codex.cmd'
      ],
      alias: '20',
      expected: 'home/.nvm/versions/node/v20.1.0/bin/codex.cmd'
    },
    { name: 'a miss everywhere returns the bare name', files: [], expected: null }
  ])('$name', async ({ files, alias, expected }) => {
    stage(...files)
    if (alias) {
      writeFileSync(join(root, 'home/.nvm/alias/default'), alias)
    }
    const sync = resolveCliCommand('codex', options('a', 'b'))
    expect(sync).toBe(expected === null ? 'codex' : join(root, expected))
    expect(await resolveCliCommandAsync('codex', options('a', 'b'))).toBe(sync)
  })
})

it('reads nothing synchronously, even when a PATH miss walks nvm and install dirs', async () => {
  stage('home/.nvm/alias/default', 'home/.nvm/versions/node/v20.1.0/bin/codex.cmd')
  writeFileSync(join(root, 'home/.nvm/alias/default'), '20')
  const options = {
    pathEnv: join(root, 'a'),
    homePath: join(root, 'home'),
    platform: 'win32' as const
  }
  syncFs.forbidden = true

  await expect(resolveCliCommandAsync('codex', options)).resolves.toBe(
    join(root, 'home/.nvm/versions/node/v20.1.0/bin/codex.cmd')
  )
  expect(syncFs.calls).toEqual([])
  // The guard is live: the sync resolver hits it and cannot find the same install.
  expect(resolveCliCommand('codex', options)).toBe('codex')
  expect(syncFs.calls).not.toEqual([])
})
