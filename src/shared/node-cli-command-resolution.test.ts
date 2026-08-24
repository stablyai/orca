import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveCliCommand, resolveCliCommands } from './node-cli-command-resolution'

function writeExecutable(directory: string, name: string): string {
  mkdirSync(directory, { recursive: true })
  const filePath = join(directory, name)
  writeFileSync(filePath, '#!/bin/sh\n')
  chmodSync(filePath, 0o755)
  return filePath
}

describe('node-cli-command-resolution Homebrew fallback', () => {
  let homePath: string

  beforeEach(() => {
    homePath = mkdtempSync(join(tmpdir(), 'orca-cli-resolution-'))
  })

  afterEach(() => {
    rmSync(homePath, { recursive: true, force: true })
  })

  // Why: the user-home Linuxbrew prefix is the one brew directory a test can
  // create; the absolute darwin/linuxbrew prefixes share the same lookup path.
  const linuxbrewBin = (): string => join(homePath, '.linuxbrew', 'bin')

  it('resolves a CLI from the Linuxbrew bin directory when it is not on PATH', () => {
    const claudePath = writeExecutable(linuxbrewBin(), 'claude')
    expect(resolveCliCommand('claude', { platform: 'linux', homePath, pathEnv: '' })).toBe(
      claudePath
    )
  })

  it('prefers a PATH entry over the Homebrew fallback', () => {
    writeExecutable(linuxbrewBin(), 'claude')
    const pathBin = join(homePath, 'path-bin')
    const pathClaude = writeExecutable(pathBin, 'claude')
    expect(resolveCliCommand('claude', { platform: 'linux', homePath, pathEnv: pathBin })).toBe(
      pathClaude
    )
  })

  it('prefers version-manager directories over the Homebrew fallback', () => {
    writeExecutable(linuxbrewBin(), 'claude')
    const localBinClaude = writeExecutable(join(homePath, '.local', 'bin'), 'claude')
    expect(resolveCliCommand('claude', { platform: 'linux', homePath, pathEnv: '' })).toBe(
      localBinClaude
    )
  })

  it('finds brew-installed CLIs during bulk resolution', () => {
    const claudePath = writeExecutable(linuxbrewBin(), 'claude')
    const resolved = resolveCliCommands(['claude', 'codex'], {
      platform: 'linux',
      homePath,
      pathEnv: ''
    })
    expect(resolved.get('claude')).toBe(claudePath)
    // Why: an unresolved command stays a bare name so callers can tell it apart.
    expect(resolved.get('codex')).toBe('codex')
  })

  it('does not probe brew directories on Windows', () => {
    writeExecutable(linuxbrewBin(), 'claude')
    expect(resolveCliCommand('claude', { platform: 'win32', homePath, pathEnv: '' })).toBe('claude')
  })
})
