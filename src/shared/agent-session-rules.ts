import type {
  AgentSessionRule,
  AgentSessionRulesSettings,
  RepoAgentSessionRuleOverrides
} from './agent-session-rules-types'

const GRAPHIFY_RULE_CONTENT = `Before answering any question about this codebase's architecture, file relationships, or "how does X work / what calls Y / where is Z defined" — check whether \`graphify-out/graph.json\` exists in the current project root.

- If it exists: treat the question as a graphify query first. Run \`graphify query "<question>"\` (or \`graphify path "<A>" "<B>"\` for a specific route, \`graphify explain "<name>"\` for a single concept) and answer from its output before falling back to manual grep/read. Do not rebuild the graph (no \`--update\`, no fresh \`/graphify\` run) unless the user explicitly asks for a rebuild or the graph is visibly stale.
- If it does not exist: this rule does not apply — proceed with your normal approach. Do not run \`/graphify\` unprompted just to create one.`

export const BUILTIN_AGENT_SESSION_RULES: readonly AgentSessionRule[] = [
  {
    id: 'builtin-graphify',
    label: 'graphify: query-first for codebase questions',
    content: GRAPHIFY_RULE_CONTENT,
    enabled: true,
    source: 'builtin'
  }
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isAgentSessionRule(value: unknown): value is AgentSessionRule {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.label === 'string' &&
    typeof value.content === 'string' &&
    typeof value.enabled === 'boolean' &&
    (value.source === 'builtin' || value.source === 'custom')
  )
}

export function normalizeAgentSessionRulesSettings(
  raw: AgentSessionRulesSettings | null | undefined
): AgentSessionRulesSettings {
  const rawRules = Array.isArray(raw?.rules) ? raw.rules.filter(isAgentSessionRule) : []
  const rawRulesById = new Map(rawRules.map((rule) => [rule.id, rule]))
  const seenBuiltinRuleIds = new Set(
    Array.isArray(raw?.seenBuiltinRuleIds)
      ? raw.seenBuiltinRuleIds.filter((id): id is string => typeof id === 'string')
      : []
  )

  const seededBuiltinRules: AgentSessionRule[] = []
  for (const builtin of BUILTIN_AGENT_SESSION_RULES) {
    const existing = rawRulesById.get(builtin.id)
    if (existing) {
      seededBuiltinRules.push({ ...builtin, enabled: existing.enabled })
      seenBuiltinRuleIds.add(builtin.id)
      continue
    }
    // Why: only seed a builtin the first time this profile ever sees it — once
    // seen, its absence means the user removed it, so it must stay removed.
    if (!seenBuiltinRuleIds.has(builtin.id)) {
      seededBuiltinRules.push(builtin)
      seenBuiltinRuleIds.add(builtin.id)
    }
  }

  const builtinIds = new Set(BUILTIN_AGENT_SESSION_RULES.map((rule) => rule.id))
  const customRules = rawRules.filter((rule) => !builtinIds.has(rule.id))

  return {
    enabled: typeof raw?.enabled === 'boolean' ? raw.enabled : true,
    rules: [...seededBuiltinRules, ...customRules],
    seenBuiltinRuleIds: Array.from(seenBuiltinRuleIds)
  }
}

function repoEnabledOverride(value: boolean | null | undefined): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

export function resolveAgentSessionRulesEnabled(
  global: AgentSessionRulesSettings | null | undefined,
  repoOverride?: RepoAgentSessionRuleOverrides | null
): boolean {
  return (
    repoEnabledOverride(repoOverride?.enabled) ?? normalizeAgentSessionRulesSettings(global).enabled
  )
}

export function resolveEffectiveAgentSessionRules(
  global: AgentSessionRulesSettings | null | undefined,
  repoOverride?: RepoAgentSessionRuleOverrides | null
): AgentSessionRule[] {
  const normalizedGlobal = normalizeAgentSessionRulesSettings(global)
  if (!resolveAgentSessionRulesEnabled(normalizedGlobal, repoOverride)) {
    return []
  }
  const disabledRuleIds = new Set(
    (repoOverride?.disabledRuleIds ?? []).filter((id): id is string => typeof id === 'string')
  )
  const globalRules = normalizedGlobal.rules.filter(
    (rule) => rule.enabled && rule.content.trim().length > 0 && !disabledRuleIds.has(rule.id)
  )
  const extraRules = (repoOverride?.extraRules ?? [])
    .filter(isAgentSessionRule)
    .filter((rule) => rule.source === 'custom' && rule.enabled && rule.content.trim().length > 0)
  return [...globalRules, ...extraRules]
}

export function normalizeRepoAgentSessionRuleOverrides(
  value: unknown
): RepoAgentSessionRuleOverrides | undefined {
  if (!isRecord(value)) {
    return undefined
  }
  const normalized: RepoAgentSessionRuleOverrides = {}
  if (typeof value.enabled === 'boolean') {
    normalized.enabled = value.enabled
  }
  if (Array.isArray(value.disabledRuleIds)) {
    const disabledRuleIds = value.disabledRuleIds.filter(
      (id): id is string => typeof id === 'string'
    )
    if (disabledRuleIds.length > 0) {
      normalized.disabledRuleIds = disabledRuleIds
    }
  }
  if (Array.isArray(value.extraRules)) {
    const extraRules = value.extraRules.filter(
      (rule): rule is AgentSessionRule => isAgentSessionRule(rule) && rule.source === 'custom'
    )
    if (extraRules.length > 0) {
      normalized.extraRules = extraRules
    }
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined
}

export function serializeAgentSessionRulesForInjection(rules: AgentSessionRule[]): string {
  if (rules.length === 0) {
    return ''
  }
  return rules.map((rule) => `## ${rule.label}\n\n${rule.content}`).join('\n\n')
}
