import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { getVersionManagerBinPaths, resolveCliCommand } from './node-cli-command-resolution'

/**
 * The seed decides which node a CLI runs under whenever the login-shell probe
 * does not land (timeout, or a shell whose rc never initializes nvm). Picking
 * the newest install there is what broke #10932: the newest version is usually
 * the one the user just added and has installed nothing into.
 */
function makeNvmHome(options: {
  versions: string[]
  defaultAlias?: string
  aliases?: Record<string, string>
  cliIn?: string
}): string {
  const home = mkdtempSync(join(tmpdir(), 'orca-nvm-'))
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

  // Why skipIf rather than renaming the fixture: `lts/*` is the real alias nvm
  // ships, and `*` is a reserved Win32 filename character, so the fixture cannot
  // be materialized there. Keeping the real name is worth more than the case
  // running on a platform where seededNvmDir already pins platform: 'darwin'.
  it.skipIf(process.platform === 'win32')(
    'follows an alias chain (default -> lts/* -> lts/krypton -> version)',
    () => {
      const home = makeNvmHome({
        versions: ['v22.9.0', 'v26.7.0'],
        defaultAlias: 'lts/*',
        aliases: { 'lts/*': 'lts/krypton', 'lts/krypton': 'v22.9.0' },
        cliIn: 'v22.9.0'
      })
      expect(seededNvmDir(home)).toBe(join(home, '.nvm', 'versions', 'node', 'v22.9.0', 'bin'))
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

  // Why the digit-leading entries: parseInt stops at the first non-digit, so
  // anchoring only the first character still let `0x18` and `00` parse to 0 and
  // prefix-match a decade-old v0.x. nvm writes such a token to the alias file
  // even while warning it does not exist, then answers N/A for it.
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
    // Why v0.12.7 is in the fixture: parseVersionSegment coerces unparseable
    // segments to 0, so before the shape guard these tokens became [0] and
    // prefix-matched the 0.x install — seeding a decade-old node.
    const home = makeNvmHome({
      versions: ['v0.12.7', 'v24.18.0', 'v26.7.0'],
      defaultAlias: token
    })
    expect(seededNvmDir(home)).toBe(join(home, '.nvm', 'versions', 'node', 'v26.7.0', 'bin'))
  })

  it('still treats a numeric default as a version prefix, matching nvm', () => {
    // The guard must reject non-versions without rejecting legitimate prefixes:
    // real nvm resolves `0` to an installed v0.x.
    const home = makeNvmHome({ versions: ['v0.12.7', 'v24.18.0'], defaultAlias: '0' })
    expect(seededNvmDir(home)).toBe(join(home, '.nvm', 'versions', 'node', 'v0.12.7', 'bin'))
  })

  it('still finds a CLI that lives outside the default version', () => {
    // Ordering must be a preference, not a restriction: the other versions stay
    // as fallbacks so a CLI installed elsewhere is still reachable.
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
