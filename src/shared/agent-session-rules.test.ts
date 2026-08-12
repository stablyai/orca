import { describe, expect, it } from 'vitest'
import {
  BUILTIN_AGENT_SESSION_RULES,
  normalizeAgentSessionRulesSettings,
  normalizeRepoAgentSessionRuleOverrides,
  resolveAgentSessionRulesEnabled,
  resolveEffectiveAgentSessionRules,
  serializeAgentSessionRulesForInjection
} from './agent-session-rules'
import type { AgentSessionRule, AgentSessionRulesSettings } from './agent-session-rules-types'

const CUSTOM_RULE: AgentSessionRule = {
  id: 'custom-tabs',
  label: 'Use tabs',
  content: 'Always indent with tabs.',
  enabled: true,
  source: 'custom'
}

function globalSettings(overrides?: Partial<AgentSessionRulesSettings>): AgentSessionRulesSettings {
  return normalizeAgentSessionRulesSettings({ enabled: true, rules: [CUSTOM_RULE], ...overrides })
}

describe('normalizeAgentSessionRulesSettings', () => {
  it('seeds the builtin graphify rule for a brand-new profile', () => {
    const normalized = normalizeAgentSessionRulesSettings(undefined)
    expect(normalized.enabled).toBe(true)
    expect(normalized.rules).toEqual(BUILTIN_AGENT_SESSION_RULES)
    expect(normalized.seenBuiltinRuleIds).toEqual(['builtin-graphify'])
  })

  it('does not re-inject a builtin rule the profile has already seen and removed', () => {
    const afterRemoval = normalizeAgentSessionRulesSettings({
      enabled: true,
      rules: [],
      seenBuiltinRuleIds: ['builtin-graphify']
    })
    expect(afterRemoval.rules.find((rule) => rule.id === 'builtin-graphify')).toBeUndefined()
  })

  it('keeps a user-disabled builtin rule disabled across repeated normalization (no revival)', () => {
    const disabled: AgentSessionRulesSettings = {
      enabled: true,
      rules: [{ ...BUILTIN_AGENT_SESSION_RULES[0], enabled: false }],
      seenBuiltinRuleIds: ['builtin-graphify']
    }
    const first = normalizeAgentSessionRulesSettings(disabled)
    const second = normalizeAgentSessionRulesSettings(first)
    expect(first.rules.find((rule) => rule.id === 'builtin-graphify')?.enabled).toBe(false)
    expect(second.rules.find((rule) => rule.id === 'builtin-graphify')?.enabled).toBe(false)
  })

  it('refreshes builtin text on upgrade while preserving the user enabled choice', () => {
    const staleBuiltin: AgentSessionRule = {
      ...BUILTIN_AGENT_SESSION_RULES[0],
      label: 'old label',
      content: 'old workflow',
      enabled: false
    }

    const normalized = normalizeAgentSessionRulesSettings({
      enabled: true,
      rules: [staleBuiltin],
      seenBuiltinRuleIds: ['builtin-graphify']
    })

    expect(normalized.rules[0]).toEqual({
      ...BUILTIN_AGENT_SESSION_RULES[0],
      enabled: false
    })
  })

  it('is idempotent across repeated normalization passes (no duplicate injection on upgrade)', () => {
    const first = normalizeAgentSessionRulesSettings(undefined)
    const second = normalizeAgentSessionRulesSettings(first)
    expect(second.rules.filter((rule) => rule.id === 'builtin-graphify')).toHaveLength(1)
    expect(second.rules).toEqual(first.rules)
    expect(second.seenBuiltinRuleIds).toEqual(first.seenBuiltinRuleIds)
  })

  it('preserves custom rules alongside seeded builtin rules', () => {
    const normalized = globalSettings()
    expect(normalized.rules.map((rule) => rule.id)).toEqual(['builtin-graphify', 'custom-tabs'])
  })
})

describe('resolveEffectiveAgentSessionRules', () => {
  it('resolves the pure global rule set with no repo override', () => {
    const rules = resolveEffectiveAgentSessionRules(globalSettings())
    expect(rules.map((rule) => rule.id)).toEqual(['builtin-graphify', 'custom-tabs'])
  })

  it('suppresses a rule the repo lists in disabledRuleIds', () => {
    const rules = resolveEffectiveAgentSessionRules(globalSettings(), {
      disabledRuleIds: ['builtin-graphify']
    })
    expect(rules.map((rule) => rule.id)).toEqual(['custom-tabs'])
  })

  it('appends repo-only extraRules after the global rules', () => {
    const repoOnlyRule: AgentSessionRule = {
      id: 'repo-only',
      label: 'Repo-only rule',
      content: 'This rule only applies to this repo.',
      enabled: true,
      source: 'custom'
    }
    const rules = resolveEffectiveAgentSessionRules(globalSettings(), {
      extraRules: [repoOnlyRule]
    })
    expect(rules.map((rule) => rule.id)).toEqual(['builtin-graphify', 'custom-tabs', 'repo-only'])
  })

  it('returns an empty array when the master switch is off', () => {
    const rules = resolveEffectiveAgentSessionRules(globalSettings({ enabled: false }))
    expect(rules).toEqual([])
  })

  it('returns an empty array when the repo override turns the switch off', () => {
    const rules = resolveEffectiveAgentSessionRules(globalSettings(), { enabled: false })
    expect(rules).toEqual([])
  })

  it('does not inject enabled rules whose content is blank', () => {
    const rules = resolveEffectiveAgentSessionRules({
      enabled: true,
      rules: [{ ...CUSTOM_RULE, content: '  \n  ' }],
      seenBuiltinRuleIds: ['builtin-graphify']
    })

    expect(rules).toEqual([])
  })

  it('degrades to pure global resolution when there is no repo (folder workspace)', () => {
    const rules = resolveEffectiveAgentSessionRules(globalSettings(), null)
    expect(rules.map((rule) => rule.id)).toEqual(['builtin-graphify', 'custom-tabs'])
  })
})

describe('resolveAgentSessionRulesEnabled', () => {
  it('falls back to the global switch when the repo has no override', () => {
    expect(resolveAgentSessionRulesEnabled(globalSettings({ enabled: false }))).toBe(false)
  })

  it('lets an explicit repo override win over the global switch', () => {
    expect(
      resolveAgentSessionRulesEnabled(globalSettings({ enabled: false }), { enabled: true })
    ).toBe(true)
  })

  it('treats a null repo override as inherit, same as undefined', () => {
    expect(
      resolveAgentSessionRulesEnabled(globalSettings({ enabled: false }), { enabled: null })
    ).toBe(false)
  })
})

describe('normalizeRepoAgentSessionRuleOverrides', () => {
  it('returns undefined for a non-object value', () => {
    expect(normalizeRepoAgentSessionRuleOverrides(undefined)).toBeUndefined()
    expect(normalizeRepoAgentSessionRuleOverrides(null)).toBeUndefined()
  })

  it('returns undefined for an empty override object', () => {
    expect(normalizeRepoAgentSessionRuleOverrides({})).toBeUndefined()
  })

  it('keeps a boolean enabled override', () => {
    expect(normalizeRepoAgentSessionRuleOverrides({ enabled: false })).toEqual({ enabled: false })
  })

  it('drops non-string entries from disabledRuleIds', () => {
    expect(
      normalizeRepoAgentSessionRuleOverrides({ disabledRuleIds: ['builtin-graphify', 42] })
    ).toEqual({ disabledRuleIds: ['builtin-graphify'] })
  })

  it('drops malformed entries from extraRules', () => {
    const repoOnlyRule: AgentSessionRule = {
      id: 'repo-only',
      label: 'Repo-only rule',
      content: 'This rule only applies to this repo.',
      enabled: true,
      source: 'custom'
    }
    expect(
      normalizeRepoAgentSessionRuleOverrides({ extraRules: [repoOnlyRule, { id: 'bad' }] })
    ).toEqual({ extraRules: [repoOnlyRule] })
  })

  it('drops builtin-shaped entries from repo-only extraRules', () => {
    expect(
      normalizeRepoAgentSessionRuleOverrides({
        extraRules: [BUILTIN_AGENT_SESSION_RULES[0]]
      })
    ).toBeUndefined()
  })
})

describe('serializeAgentSessionRulesForInjection', () => {
  it('returns an empty string for an empty rule list', () => {
    expect(serializeAgentSessionRulesForInjection([])).toBe('')
  })

  it('joins rules into labeled sections', () => {
    const serialized = serializeAgentSessionRulesForInjection([CUSTOM_RULE])
    expect(serialized).toBe(`## ${CUSTOM_RULE.label}\n\n${CUSTOM_RULE.content}`)
  })
})
