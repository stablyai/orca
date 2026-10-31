import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  getVersionManagerBinPaths,
  installedCliCandidates,
  resolveCliCommand
} from './node-cli-command-resolution'
import { runCliFsReadsAsync } from './cli-fs-reads'

/** Default Node seeds fallback when login probing times out or omits nvm. Newest-first hid CLIs installed under the default (#10932). */
function makeNvmHome(
  options: {
    versions: string[]
    defaultAlias?: string
    aliases?: Record<string, string>
    cliIn?: string
  },
  home = mkdtempSync(join(tmpdir(), 'orca-nvm-'))
): string {
  for (const version of options.versions) {
    const bin = join(home, '.nvm', 'versions', 'node', version, 'bin')
    mkdirSync(bin, { recursive: true })
    for (const name of ['node', 'node.exe']) {
      writeFileSync(join(bin, name), '')
      chmodSync(join(bin, name), 0o755)
    }
    if (options.cliIn === version) {
      writeFileSync(join(bin, 'codex'), '')
      chmodSync(join(bin, 'codex'), 0o755)
    }
  }
  if (options.defaultAlias !== undefined) {
    mkdirSync(join(home, '.nvm', 'alias'), { recursive: true })
    writeFileSync(join(home, '.nvm', 'alias', 'default'), `${options.defaultAlias}\n`)
  }
  for (const [name, value] of Object.entries(options.aliases ?? {})) {
    const file = join(home, '.nvm', 'alias', name)
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, `${value}\n`)
  }
  return home
}

function seededNvmDir(homePath: string): string | undefined {
  return getVersionManagerBinPaths({ platform: 'darwin', pathEnv: '', homePath }).find((entry) =>
    entry.includes('.nvm')
  )
}

describe('nvm default alias decides the seeded runtime', () => {
  it('seeds the default version, not the newest install (#10932)', () => {
    // The exact shape that broke: `nvm install 26` adds a bare newest version
    // while every CLI lives under the default.
    const home = makeNvmHome({
      versions: ['v24.18.0', 'v26.7.0'],
      defaultAlias: '24',
      cliIn: 'v24.18.0'
    })
    expect(seededNvmDir(home)).toBe(join(home, '.nvm', 'versions', 'node', 'v24.18.0', 'bin'))
  })

  it('resolves a partial default to the highest matching install', () => {
    const home = makeNvmHome({
      versions: ['v24.9.0', 'v24.18.0', 'v26.7.0'],
      defaultAlias: '24',
      cliIn: 'v24.18.0'
    })
    expect(seededNvmDir(home)).toBe(join(home, '.nvm', 'versions', 'node', 'v24.18.0', 'bin'))
  })

  // Real lts/* aliases cannot be materialized on Win32 (* is reserved). Keep faithful names and skip there; the resolver test targets darwin.
  it.skipIf(process.platform === 'win32')(
    'follows an alias chain (default -> lts/* -> lts/krypton -> version)',
    async () => {
      const parent = makeNvmHome({
        versions: ['v22.9.0', 'v26.7.0'],
        defaultAlias: 'v26.7.0'
      })
      try {
        const home = makeNvmHome(
          {
            versions: ['v22.9.0', 'v26.7.0'],
            defaultAlias: 'lts/*',
            aliases: { 'lts/*': 'lts/krypton', 'lts/krypton': 'v22.9.0' },
            cliIn: 'v22.9.0'
          },
          join(parent, 'actual')
        )
        mkdirSync(join(home, 'nested'))
        symlinkSync(join(home, 'nested'), join(parent, 'link'))
        const literalHome = `${parent}/link/..`
        for (const root of [parent, home]) {
          for (const version of ['v22.9.0', 'v26.7.0']) {
            for (const command of ['codex', 'claude']) {
              const program = join(root, '.nvm', 'versions', 'node', version, 'bin', command)
              writeFileSync(program, '#!/bin/sh\n')
              chmodSync(program, 0o755)
            }
          }
        }
        const defaultBin = join(home, '.nvm', 'versions', 'node', 'v22.9.0', 'bin')
        const decoyBin = join(parent, '.nvm', 'versions', 'node', 'v26.7.0', 'bin')
        expect(seededNvmDir(home)).toBe(defaultBin)
        expect(seededNvmDir(parent)).toBe(decoyBin)
        expect(seededNvmDir(literalHome)).toBe(decoyBin)
        for (const command of ['codex', 'claude']) {
          const canonical = await runCliFsReadsAsync(
            installedCliCandidates(command, 'darwin', home, () => true)
          )
          expect(canonical.slice(0, 2)).toEqual([
            `${home}/.nvm/versions/node/v22.9.0/bin/${command}`,
            `${home}/.nvm/versions/node/v26.7.0/bin/${command}`
          ])
          expect(
            resolveCliCommand(command, { platform: 'darwin', pathEnv: '', homePath: home })
          ).toBe(`${defaultBin}/${command}`)
          const literal = await runCliFsReadsAsync(
            installedCliCandidates(command, 'darwin', literalHome, () => true)
          )
          expect(literal.slice(0, 2)).toEqual([
            `${literalHome}/.nvm/versions/node/v22.9.0/bin/${command}`,
            `${literalHome}/.nvm/versions/node/v26.7.0/bin/${command}`
          ])
          expect(
            resolveCliCommand(command, { platform: 'darwin', pathEnv: '', homePath: literalHome })
          ).toBe(`${decoyBin}/${command}`)
        }
      } finally {
        rmSync(parent, { recursive: true, force: true })
      }
    }
  )

  it('falls back to newest when there is no default alias', () => {
    const home = makeNvmHome({ versions: ['v24.18.0', 'v26.7.0'] })
    expect(seededNvmDir(home)).toBe(join(home, '.nvm', 'versions', 'node', 'v26.7.0', 'bin'))
  })

  it('falls back to newest when the default names an uninstalled version', () => {
    const home = makeNvmHome({ versions: ['v24.18.0', 'v26.7.0'], defaultAlias: '18' })
    expect(seededNvmDir(home)).toBe(join(home, '.nvm', 'versions', 'node', 'v26.7.0', 'bin'))
  })

  it('survives a cyclic alias chain instead of hanging', () => {
    const home = makeNvmHome({
      versions: ['v24.18.0', 'v26.7.0'],
      defaultAlias: 'a',
      aliases: { a: 'b', b: 'a' }
    })
    expect(seededNvmDir(home)).toBe(join(home, '.nvm', 'versions', 'node', 'v26.7.0', 'bin'))
  })

  it('ignores a `system` default, which means no nvm node at all', () => {
    const home = makeNvmHome({ versions: ['v24.18.0', 'v26.7.0'], defaultAlias: 'system' })
    expect(seededNvmDir(home)).toBe(join(home, '.nvm', 'versions', 'node', 'v26.7.0', 'bin'))
  })

  // Digit-leading 0x18/00 also coerce to zero with parseInt; nvm persists nonexistent aliases but resolves them as N/A.
  it.each([
    'garbage',
    'iojs',
    'lts/nonexistent',
    'my-custom-alias',
    '0x18',
    '00',
    '0abc',
    '024',
    '24abc',
    'v24.18.0-nightly',
    'V24'
  ])('treats the unresolvable default %s as no preference, like nvm N/A', (token) => {
    // Unparseable aliases previously coerced to [0], selecting this v0.12.7 sentinel.
    const home = makeNvmHome({
      versions: ['v0.12.7', 'v24.18.0', 'v26.7.0'],
      defaultAlias: token
    })
    expect(seededNvmDir(home)).toBe(join(home, '.nvm', 'versions', 'node', 'v26.7.0', 'bin'))
  })

  it('still treats a numeric default as a version prefix, matching nvm', () => {
    // Reject malformed aliases while retaining nvm’s valid numeric prefix 0 → installed v0.x.
    const home = makeNvmHome({ versions: ['v0.12.7', 'v24.18.0'], defaultAlias: '0' })
    expect(seededNvmDir(home)).toBe(join(home, '.nvm', 'versions', 'node', 'v0.12.7', 'bin'))
  })

  it('still finds a CLI that lives outside the default version', () => {
    // Default-first is preference only; retain other installed versions as CLI fallbacks.
    const home = makeNvmHome({
      versions: ['v24.18.0', 'v26.7.0'],
      defaultAlias: '24',
      cliIn: 'v26.7.0'
    })
    expect(resolveCliCommand('codex', { platform: 'darwin', pathEnv: '', homePath: home })).toBe(
      join(home, '.nvm', 'versions', 'node', 'v26.7.0', 'bin', 'codex')
    )
  })
})
