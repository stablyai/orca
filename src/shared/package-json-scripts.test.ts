import { describe, expect, it } from 'vitest'
import {
  buildPackageManagerRunCommand,
  detectPackageManagerFromField,
  detectPackageManagerFromLockfiles,
  getPackageJsonField,
  parsePackageJsonScripts,
  resolvePackageManager
} from './package-json-scripts'

describe('parsePackageJsonScripts', () => {
  it('extracts string-valued scripts in declared order', () => {
    const content = JSON.stringify({
      scripts: { dev: 'vite', build: 'vite build', test: 'vitest' }
    })
    expect(parsePackageJsonScripts(content)).toEqual([
      { name: 'dev', command: 'vite' },
      { name: 'build', command: 'vite build' },
      { name: 'test', command: 'vitest' }
    ])
  })

  it('ignores non-string script values and blank names', () => {
    const content = JSON.stringify({
      scripts: { dev: 'vite', bad: 42, nested: { a: 1 }, '': 'noop' }
    })
    expect(parsePackageJsonScripts(content)).toEqual([{ name: 'dev', command: 'vite' }])
  })

  it('returns an empty array for missing, empty, or invalid input', () => {
    expect(parsePackageJsonScripts(null)).toEqual([])
    expect(parsePackageJsonScripts('')).toEqual([])
    expect(parsePackageJsonScripts('not json')).toEqual([])
    expect(parsePackageJsonScripts(JSON.stringify({}))).toEqual([])
    expect(parsePackageJsonScripts(JSON.stringify({ scripts: [] }))).toEqual([])
  })
})

describe('package manager detection', () => {
  it('reads the packageManager field', () => {
    expect(detectPackageManagerFromField('pnpm@9.1.0')).toBe('pnpm')
    expect(detectPackageManagerFromField('yarn@4.0.0')).toBe('yarn')
    expect(detectPackageManagerFromField('bun@1.1.0')).toBe('bun')
    expect(detectPackageManagerFromField('npm@10.0.0')).toBe('npm')
    expect(detectPackageManagerFromField('deno@1.0.0')).toBeNull()
    expect(detectPackageManagerFromField(undefined)).toBeNull()
  })

  it('reads a single lockfile', () => {
    expect(detectPackageManagerFromLockfiles(['pnpm-lock.yaml', 'README.md'])).toBe('pnpm')
    expect(detectPackageManagerFromLockfiles(['yarn.lock'])).toBe('yarn')
    expect(detectPackageManagerFromLockfiles(['bun.lockb'])).toBe('bun')
  })

  it('returns null on conflicting or absent lockfiles', () => {
    expect(detectPackageManagerFromLockfiles(['pnpm-lock.yaml', 'yarn.lock'])).toBeNull()
    expect(detectPackageManagerFromLockfiles(['README.md'])).toBeNull()
  })

  it('prefers the field, then lockfiles, then npm', () => {
    expect(resolvePackageManager('pnpm@9', ['yarn.lock'])).toBe('pnpm')
    expect(resolvePackageManager(undefined, ['yarn.lock'])).toBe('yarn')
    expect(resolvePackageManager(undefined, [])).toBe('npm')
  })
})

describe('buildPackageManagerRunCommand', () => {
  it('builds a uniform run command per manager', () => {
    expect(buildPackageManagerRunCommand('npm', 'dev')).toBe('npm run dev')
    expect(buildPackageManagerRunCommand('pnpm', 'build')).toBe('pnpm run build')
    expect(buildPackageManagerRunCommand('yarn', 'test')).toBe('yarn run test')
    expect(buildPackageManagerRunCommand('bun', 'lint')).toBe('bun run lint')
  })
})

describe('getPackageJsonField', () => {
  it('returns a top-level field or undefined', () => {
    const content = JSON.stringify({ name: 'orca', packageManager: 'pnpm@9' })
    expect(getPackageJsonField(content, 'packageManager')).toBe('pnpm@9')
    expect(getPackageJsonField(content, 'missing')).toBeUndefined()
    expect(getPackageJsonField(null, 'name')).toBeUndefined()
  })
})
