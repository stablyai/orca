import type { DevRule, DevRuleScope } from './types'

const MAX_DEV_RULES = 100
const MAX_DEV_RULE_NAME_LENGTH = 120
const MAX_DEV_RULE_ID_LENGTH = 120
const MAX_DEV_RULE_REPO_ID_LENGTH = 200
const MAX_DEV_RULE_CONTENT_LENGTH = 20000

const DEFAULT_DEV_RULES: DevRule[] = []

export function getDefaultDevRules(): DevRule[] {
  return DEFAULT_DEV_RULES.map((dataRule) => ({ ...dataRule }))
}

function normalizeDevRuleScope(input: unknown): DevRuleScope {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { type: 'global' }
  }
  const record = input as Record<string, unknown>
  if (record.type !== 'repo') {
    return { type: 'global' }
  }
  const repoId = typeof record.repoId === 'string' ? record.repoId.trim() : ''
  if (!repoId) {
    return { type: 'global' }
  }
  return { type: 'repo', repoId: repoId.slice(0, MAX_DEV_RULE_REPO_ID_LENGTH) }
}

export function getDevRuleScope(rule: DevRule): DevRuleScope {
  return normalizeDevRuleScope(rule.scope)
}

export function devRuleMatchesRepo(rule: DevRule, repoId: string | null): boolean {
  const scope = getDevRuleScope(rule)
  return scope.type === 'global' || (repoId !== null && scope.repoId === repoId)
}

export function normalizeDevRules(input: unknown): DevRule[] {
  if (!Array.isArray(input)) {
    return getDefaultDevRules()
  }

  const normalized: DevRule[] = []
  const seenIds = new Set<string>()

  for (const item of input) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      continue
    }
    const record = item as Record<string, unknown>
    const hasName = typeof record.name === 'string'
    const hasContent = typeof record.content === 'string'
    const rawId = typeof record.id === 'string' ? record.id.trim() : ''
    // Why: settings saves on every edit; preserve incomplete rows so a newly
    // added rule is not deleted before the user fills in its text.
    if (!hasName && !hasContent && !rawId) {
      continue
    }

    const idBase = rawId || `dev-rule-${normalized.length + 1}`
    let id = idBase.slice(0, MAX_DEV_RULE_ID_LENGTH)
    let suffix = 2
    while (seenIds.has(id)) {
      id = `${idBase.slice(0, MAX_DEV_RULE_ID_LENGTH - 4)}-${suffix}`
      suffix += 1
    }
    seenIds.add(id)

    normalized.push({
      id,
      name: (hasName ? String(record.name).trim() : '').slice(0, MAX_DEV_RULE_NAME_LENGTH),
      content: (hasContent ? String(record.content).trim() : '').slice(
        0,
        MAX_DEV_RULE_CONTENT_LENGTH
      ),
      enabled: record.enabled !== false,
      scope: normalizeDevRuleScope(record.scope)
    })

    if (normalized.length >= MAX_DEV_RULES) {
      break
    }
  }

  return normalized
}

/** Effective enabled rules for a worktree: enabled global rules first, then
 *  enabled rules scoped to `repoId`, each group preserving its persisted order
 *  so rendered output is stable and diffs stay minimal. */
export function computeEffectiveDevRules(rules: DevRule[], repoId: string | null): DevRule[] {
  const enabled = rules.filter((rule) => rule.enabled)
  const global = enabled.filter((rule) => getDevRuleScope(rule).type === 'global')
  const repo =
    repoId === null
      ? []
      : enabled.filter((rule) => {
          const scope = getDevRuleScope(rule)
          return scope.type === 'repo' && scope.repoId === repoId
        })
  return [...global, ...repo]
}
