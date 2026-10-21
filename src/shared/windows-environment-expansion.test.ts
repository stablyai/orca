import { describe, expect, it } from 'vitest'
import {
  expandWindowsEnvironmentVariables,
  expandWindowsPathEnvironmentVariables
} from './windows-environment-expansion'

/** The per-miss `Object.keys().find()` form the lazy index replaced; the differential oracle. */
function referenceExpand(value: string, env: Readonly<Record<string, string | undefined>>): string {
  return value.replace(/%([^%]+)%/g, (match, name: string) => {
    const exactValue = env[name]
    if (typeof exactValue === 'string') {
      return exactValue
    }
    const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase())
    const fallback = key ? env[key] : undefined
    return typeof fallback === 'string' ? fallback : match
  })
}

function countingEnv(source: Record<string, string | undefined>): {
  env: Record<string, string | undefined>
  enumerations: () => number
} {
  let enumerations = 0
  const env = new Proxy(source, {
    ownKeys(target) {
      enumerations += 1
      return Reflect.ownKeys(target)
    }
  })
  return { env, enumerations: () => enumerations }
}

describe('expandWindowsEnvironmentVariables', () => {
  it('expands names case-insensitively and preserves unknown variables', () => {
    expect(
      expandWindowsEnvironmentVariables('%localappdata%\\agy\\bin;%MISSING%\\bin', {
        LOCALAPPDATA: 'C:\\Users\\orca\\AppData\\Local'
      })
    ).toBe('C:\\Users\\orca\\AppData\\Local\\agy\\bin;%MISSING%\\bin')
  })

  it('expands variables with empty values', () => {
    expect(expandWindowsEnvironmentVariables('before%EMPTY%after', { EMPTY: '' })).toBe(
      'beforeafter'
    )
  })

  it('enumerates fallback keys once for a PATH containing repeated mixed-case variables', () => {
    const { env, enumerations } = countingEnv({ ROOT: 'C:\\root', OTHER: 'unused' })
    const value = Array.from({ length: 1000 }, () => '%root%').join(';')
    expect(expandWindowsEnvironmentVariables(value, env)).toBe(
      Array(1000).fill('C:\\root').join(';')
    )
    expect(enumerations()).toBe(1)
  })

  it('never enumerates when every name resolves by exact case', () => {
    const { env, enumerations } = countingEnv({ ROOT: 'C:\\root', EMPTY: '' })
    expect(expandWindowsEnvironmentVariables('%ROOT%;%EMPTY%;plain', env)).toBe('C:\\root;;plain')
    expect(enumerations()).toBe(0)
  })

  it('preserves exact casing authority and first fallback keys including undefined values', () => {
    const env = { Root: undefined, ROOT: 'upper', root: 'lower' }
    expect(expandWindowsEnvironmentVariables('%ROOT%:%root%:%rOoT%', env)).toBe(
      'upper:lower:%rOoT%'
    )
  })

  // Why: the fallback index keeps the first insertion-order key per lowercase name, so a later
  // duplicate casing never wins even when the first one is the shadowed value.
  it('resolves an inexact name to the first case variant, not the last', () => {
    const env = { Path: 'first', PATH: 'second', pAtH: 'third' }
    expect(expandWindowsEnvironmentVariables('%PaTh%', env)).toBe('first')
  })

  it('does not resolve names from the prototype chain', () => {
    for (const name of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      expect(expandWindowsEnvironmentVariables(`%${name}%`, { ROOT: 'x' })).toBe(`%${name}%`)
    }
  })

  it('matches the per-miss lookup oracle across randomized mixed-case environments', () => {
    const names = ['PATH', 'Path', 'path', 'pAtH', 'ROOT', 'root', 'Temp', 'TEMP', 'MISSING']
    const values = ['a', '', 'C:\\x', undefined]
    let seed = 0x9e3779b9
    const next = (): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
    for (let index = 0; index < 4000; index += 1) {
      const env: Record<string, string | undefined> = {}
      for (let entry = 0; entry < Math.floor(next() * 5); entry += 1) {
        env[names[Math.floor(next() * names.length)]!] = values[Math.floor(next() * values.length)]
      }
      const value = Array.from(
        { length: Math.floor(next() * 6) },
        () => `%${names[Math.floor(next() * names.length)]}%`
      ).join(';')
      expect(expandWindowsEnvironmentVariables(value, env)).toBe(referenceExpand(value, env))
    }
  })
})

describe('expandWindowsPathEnvironmentVariables', () => {
  it('expands every Windows PATH casing without changing other variables', () => {
    const env = {
      ORCA_PATH_ROOT: 'C:\\Users\\orca',
      Path: '%ORCA_PATH_ROOT%\\bin',
      PATH: '%orca_path_root%\\tools',
      TEMPLATE: '%ORCA_PATH_ROOT%\\template'
    }

    expandWindowsPathEnvironmentVariables(env, 'win32')

    expect(env.Path).toBe('C:\\Users\\orca\\bin')
    expect(env.PATH).toBe('C:\\Users\\orca\\tools')
    expect(env.TEMPLATE).toBe('%ORCA_PATH_ROOT%\\template')
  })

  it('leaves non-Windows PATH values unchanged', () => {
    const env = { ROOT: '/opt/orca', PATH: '%ROOT%/bin:/usr/bin' }

    expandWindowsPathEnvironmentVariables(env, 'linux')

    expect(env.PATH).toBe('%ROOT%/bin:/usr/bin')
  })
})
