import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveCliCommand, resolveCliCommandCandidates } from './node-cli-command-resolution'

function makeFakeBin(): string {
  const dir = mkdtempSync(join(tmpdir(), 'npx-resolve-'))
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  const shim = join(bin, 'npx')
  writeFileSync(shim, '#!/usr/bin/env sh\nexit 126\n')
  chmodSync(shim, 0o755)
  return bin
}

describe('resolveCliCommandCandidates', () => {
  it('returns every runnable candidate in PATH order', () => {
    const first = makeFakeBin()
    const second = makeFakeBin()
    const path = [first, second].join(':')

    const candidates = resolveCliCommandCandidates('npx', { pathEnv: path, platform: 'linux' })

    expect(candidates).toEqual([join(first, 'npx'), join(second, 'npx')])
  })

  it('falls back to version-manager shims when PATH has no candidate', () => {
    const home = mkdtempSync(join(tmpdir(), 'npx-home-'))
    const shims = join(home, '.asdf', 'shims')
    mkdirSync(shims, { recursive: true })
    const shim = join(shims, 'npx')
    writeFileSync(shim, '#!/usr/bin/env sh\nexit 126\n')
    chmodSync(shim, 0o755)

    const candidates = resolveCliCommandCandidates('npx', {
      pathEnv: '/usr/bin:/bin',
      platform: 'linux',
      homePath: home
    })

    expect(candidates).toContain(join(shims, 'npx'))
  })

  it('resolveCliCommand keeps returning the first candidate', () => {
    const first = makeFakeBin()
    const second = makeFakeBin()
    const path = [first, second].join(':')

    expect(resolveCliCommand('npx', { pathEnv: path, platform: 'linux' })).toBe(
      join(first, 'npx')
    )
  })

  it('deduplicates a candidate that appears both in PATH and version-manager dirs', () => {
    const home = mkdtempSync(join(tmpdir(), 'npx-home2-'))
    const shims = join(home, '.asdf', 'shims')
    mkdirSync(shims, { recursive: true })
    const shim = join(shims, 'npx')
    writeFileSync(shim, '#!/usr/bin/env sh\nexit 126\n')
    chmodSync(shim, 0o755)

    const candidates = resolveCliCommandCandidates('npx', {
      pathEnv: shims,
      platform: 'linux',
      homePath: home
    })

    // The shim dir is in PATH AND in the asdf shims list — must appear once.
    expect(candidates.filter((c) => c === shim)).toHaveLength(1)
  })
})
