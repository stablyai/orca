import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  isOrcaHomeDirName,
  ORCA_HOME_DIR_NAME,
  ORCA_REMOTE_HOME_DIR_NAME,
  orcaHomeDisplayPath,
  remoteOrcaHomePath
} from './orca-home'

describe('Orca home directory names', () => {
  it('keeps both the local and the remote home on ~/.orca by default', () => {
    expect(ORCA_HOME_DIR_NAME).toBe('.orca')
    expect(ORCA_REMOTE_HOME_DIR_NAME).toBe('.orca')
  })

  it('builds display and remote paths', () => {
    expect(orcaHomeDisplayPath()).toBe('~/.orca')
    expect(orcaHomeDisplayPath('keybindings.json')).toBe('~/.orca/keybindings.json')
    expect(remoteOrcaHomePath('/home/dev', 'agent-hooks', 'claude-hook.sh')).toBe(
      '/home/dev/.orca/agent-hooks/claude-hook.sh'
    )
    // Same single-slash trim as the inline templates it replaced.
    expect(remoteOrcaHomePath('/home/dev/', 'agent-hooks')).toBe('/home/dev/.orca/agent-hooks')
  })

  it.each([
    ['.orca', true],
    ['.pod', true],
    ['.my-app.v2', true],
    ['orca', false],
    ['.', false],
    ['..', false],
    ['.a/b', false],
    ['.a\\b', false],
    ["'.orca'", false],
    ['.orca..x', false]
  ])('validates %s as a home directory name: %s', (value, valid) => {
    expect(isOrcaHomeDirName(value)).toBe(valid)
  })
})

// Why: a downstream renames Orca's home in one place only if nothing else spells it.
describe('Orca home directory call sites', () => {
  const SOURCE_ROOT = join(__dirname, '..')
  const FORBIDDEN = [
    /homedir\(\)\s*,\s*'\.orca'/,
    /\}\/\.orca\/agent-hooks/,
    /'\.orca'\s*,\s*'agent-hooks'/,
    /\$\{HOME-\}\/\.orca\//
  ]

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) {
        return name === 'node_modules' ? [] : sourceFiles(path)
      }
      return /\.(ts|tsx)$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name) ? [path] : []
    })
  }

  it('builds every home path through the shared helpers', () => {
    const offenders = sourceFiles(SOURCE_ROOT).filter((path) => {
      const text = readFileSync(path, 'utf8')
      return FORBIDDEN.some((pattern) => pattern.test(text))
    })
    expect(offenders.map((path) => relative(SOURCE_ROOT, path))).toEqual([])
  })
})
