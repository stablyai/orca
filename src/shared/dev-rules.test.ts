import { describe, expect, it } from 'vitest'
import {
  computeEffectiveDevRules,
  devRuleMatchesRepo,
  getDefaultDevRules,
  normalizeDevRules
} from './dev-rules'
import type { DevRule } from './types'

function rule(overrides: Partial<DevRule> = {}): DevRule {
  return {
    id: 'rule-1',
    name: 'Rule 1',
    content: 'Always write tests.',
    enabled: true,
    scope: { type: 'global' },
    ...overrides
  }
}

describe('getDefaultDevRules', () => {
  it('returns an empty list', () => {
    expect(getDefaultDevRules()).toEqual([])
  })
})

describe('normalizeDevRules', () => {
  it('returns defaults for non-array input', () => {
    expect(normalizeDevRules(undefined)).toEqual([])
    expect(normalizeDevRules(null)).toEqual([])
    expect(normalizeDevRules('nope')).toEqual([])
  })

  it('keeps well-formed rules and coerces fields', () => {
    const result = normalizeDevRules([
      { id: 'a', name: 'A', content: 'do A', enabled: true, scope: { type: 'global' } }
    ])
    expect(result).toEqual([
      { id: 'a', name: 'A', content: 'do A', enabled: true, scope: { type: 'global' } }
    ])
  })

  it('drops entries that are not objects', () => {
    expect(normalizeDevRules(['x', 5, null, []])).toEqual([])
  })

  it('defaults enabled to true and trims name/content', () => {
    const [r] = normalizeDevRules([{ id: 'a', name: '  A  ', content: '  body  ' }])
    expect(r.enabled).toBe(true)
    expect(r.name).toBe('A')
    expect(r.content).toBe('body')
  })

  it('respects an explicit enabled:false', () => {
    const [r] = normalizeDevRules([{ id: 'a', name: 'A', content: 'b', enabled: false }])
    expect(r.enabled).toBe(false)
  })

  it('normalizes a repo scope and falls back to global when repoId is missing', () => {
    const [repoScoped] = normalizeDevRules([
      { id: 'a', name: 'A', content: 'b', scope: { type: 'repo', repoId: 'repo-9' } }
    ])
    expect(repoScoped.scope).toEqual({ type: 'repo', repoId: 'repo-9' })

    const [fallback] = normalizeDevRules([
      { id: 'b', name: 'B', content: 'b', scope: { type: 'repo', repoId: '   ' } }
    ])
    expect(fallback.scope).toEqual({ type: 'global' })
  })

  it('preserves incomplete rows so a freshly added rule is not deleted mid-edit', () => {
    const [r] = normalizeDevRules([{ id: 'a', name: '', content: '' }])
    expect(r).toMatchObject({ id: 'a', name: '', content: '', enabled: true })
  })

  it('drops rows with no identifying fields at all', () => {
    expect(normalizeDevRules([{ scope: { type: 'global' } }])).toEqual([])
  })

  it('dedupes ids', () => {
    const result = normalizeDevRules([
      { id: 'dup', name: 'A', content: 'a' },
      { id: 'dup', name: 'B', content: 'b' }
    ])
    expect(result.map((r) => r.id)).toEqual(['dup', 'dup-2'])
  })

  it('generates an id when missing', () => {
    const [r] = normalizeDevRules([{ name: 'A', content: 'a' }])
    expect(r.id).toBeTruthy()
  })
})

describe('devRuleMatchesRepo', () => {
  it('matches global rules for any repo', () => {
    expect(devRuleMatchesRepo(rule({ scope: { type: 'global' } }), 'repo-1')).toBe(true)
    expect(devRuleMatchesRepo(rule({ scope: { type: 'global' } }), null)).toBe(true)
  })

  it('matches repo rules only for the same repoId', () => {
    const r = rule({ scope: { type: 'repo', repoId: 'repo-1' } })
    expect(devRuleMatchesRepo(r, 'repo-1')).toBe(true)
    expect(devRuleMatchesRepo(r, 'repo-2')).toBe(false)
    expect(devRuleMatchesRepo(r, null)).toBe(false)
  })
})

describe('computeEffectiveDevRules', () => {
  it('returns enabled global rules then enabled repo rules, preserving order', () => {
    const rules: DevRule[] = [
      rule({ id: 'g1', scope: { type: 'global' } }),
      rule({ id: 'r1', scope: { type: 'repo', repoId: 'repo-1' } }),
      rule({ id: 'g2', scope: { type: 'global' } }),
      rule({ id: 'r-other', scope: { type: 'repo', repoId: 'repo-2' } })
    ]
    expect(computeEffectiveDevRules(rules, 'repo-1').map((r) => r.id)).toEqual(['g1', 'g2', 'r1'])
  })

  it('excludes disabled rules', () => {
    const rules: DevRule[] = [
      rule({ id: 'g1', enabled: false }),
      rule({ id: 'r1', enabled: true, scope: { type: 'repo', repoId: 'repo-1' } })
    ]
    expect(computeEffectiveDevRules(rules, 'repo-1').map((r) => r.id)).toEqual(['r1'])
  })

  it('returns only global rules when repoId is null', () => {
    const rules: DevRule[] = [
      rule({ id: 'g1', scope: { type: 'global' } }),
      rule({ id: 'r1', scope: { type: 'repo', repoId: 'repo-1' } })
    ]
    expect(computeEffectiveDevRules(rules, null).map((r) => r.id)).toEqual(['g1'])
  })
})
