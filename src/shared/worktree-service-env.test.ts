import { describe, expect, it } from 'vitest'
import {
  buildServiceContextEnv,
  deriveServiceSlug,
  resolveServiceEnv
} from './worktree-service-env'

describe('deriveServiceSlug', () => {
  it('sanitizes and suffixes the slot', () => {
    expect(deriveServiceSlug('Fix Migrations!', 3)).toBe('fix-migrations-s3')
  })
  it('truncates long names but keeps the slot suffix', () => {
    const slug = deriveServiceSlug('x'.repeat(100), 12)
    expect(slug.length).toBeLessThanOrEqual(40)
    expect(slug.endsWith('-s12')).toBe(true)
  })
  it('falls back when the name has no usable characters', () => {
    expect(deriveServiceSlug('***', 0)).toBe('worktree-s0')
  })
})

describe('buildServiceContextEnv', () => {
  it('exposes slug, slot, and ten deterministic ports', () => {
    const env = buildServiceContextEnv('demo-s2', 2)
    expect(env.ORCA_WORKTREE_SLUG).toBe('demo-s2')
    expect(env.ORCA_SERVICE_SLOT).toBe('2')
    expect(env.ORCA_PORT_0).toBe('20020')
    expect(env.ORCA_PORT_9).toBe('20029')
  })
})

describe('resolveServiceEnv', () => {
  it('substitutes context variables, plain string replacement', () => {
    const context = buildServiceContextEnv('demo-s0', 0)
    expect(
      resolveServiceEnv({ DATABASE_URL: 'postgres://localhost:${ORCA_PORT_0}/app' }, context)
    ).toEqual({ DATABASE_URL: 'postgres://localhost:20000/app' })
  })
  it('leaves unknown placeholders untouched and handles undefined template', () => {
    const context = buildServiceContextEnv('demo-s0', 0)
    expect(resolveServiceEnv({ A: '${NOT_A_VAR}' }, context)).toEqual({ A: '${NOT_A_VAR}' })
    expect(resolveServiceEnv(undefined, context)).toEqual({})
  })
})
