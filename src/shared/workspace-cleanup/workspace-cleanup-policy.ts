export const WORKSPACE_CLEANUP_POLICY_MIN_DAYS = 1
export const WORKSPACE_CLEANUP_POLICY_MAX_DAYS = 3650

/** 'uncommitted' keeps uncommitted and unpushed work; 'any-local-files' also keeps ignored files such as .env. */
export const WORKSPACE_CLEANUP_KEEP_WHEN_VALUES = ['uncommitted', 'any-local-files'] as const
export type WorkspaceCleanupKeepWhen = (typeof WORKSPACE_CLEANUP_KEEP_WHEN_VALUES)[number]

export const WORKSPACE_CLEANUP_INACTIVE_ACTIONS = ['delete', 'archive'] as const
export type WorkspaceCleanupInactiveAction = (typeof WORKSPACE_CLEANUP_INACTIVE_ACTIONS)[number]

// Branch policy is fixed: merged branches are deleted, unmerged ones kept.
export type WorkspaceCleanupRules = {
  merged: { enabled: boolean }
  /** Days counted from the workspace's last activity. */
  unchanged: { enabled: boolean; afterDays: number }
  inactive: { enabled: boolean; afterDays: number; action: WorkspaceCleanupInactiveAction }
  automationRuns: { enabled: boolean }
  orchestrationWorkers: { enabled: boolean }
  keepWhen: WorkspaceCleanupKeepWhen
}

export type WorkspaceCleanupPolicySettings = {
  /** Host-owned automatic cleanup rules; read through resolveWorkspaceCleanupPolicy. */
  workspaceCleanupPolicy?: WorkspaceCleanupRules
}

/** Absent inherits the global rules. Custom stores a full rule set; writers seed it from the inherited rules. */
export type RepoWorkspaceCleanupPolicy =
  | { mode: 'off' }
  | { mode: 'custom'; rules: WorkspaceCleanupRules }

export type ResolvedWorkspaceCleanupPolicy = {
  source: 'global' | 'project-off' | 'project-custom'
  rules: WorkspaceCleanupRules
  /** False while Orca cannot archive a workspace; the runner must skip an inactive rule set to archive. */
  inactiveActionSupported: boolean
}

export const WORKSPACE_CLEANUP_RULE_KEYS = [
  'merged',
  'unchanged',
  'inactive',
  'automationRuns',
  'orchestrationWorkers'
] as const satisfies readonly Exclude<keyof WorkspaceCleanupRules, 'keepWhen'>[]

export function hasEnabledWorkspaceCleanupRule(rules: WorkspaceCleanupRules): boolean {
  return WORKSPACE_CLEANUP_RULE_KEYS.some((key) => rules[key].enabled)
}

// Flip when workspace archiving exists.
export const WORKSPACE_ARCHIVE_SUPPORTED = false

export function getDefaultWorkspaceCleanupRules(): WorkspaceCleanupRules {
  return {
    merged: { enabled: false },
    unchanged: { enabled: false, afterDays: 1 },
    inactive: { enabled: false, afterDays: 30, action: 'archive' },
    automationRuns: { enabled: false },
    orchestrationWorkers: { enabled: false },
    keepWhen: 'any-local-files'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readRule(value: unknown, key: keyof WorkspaceCleanupRules): Record<string, unknown> {
  const rule = isRecord(value) ? value[key] : undefined
  return isRecord(rule) ? rule : {}
}

function normalizeEnabled(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function normalizeDays(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback
  }
  return Math.min(
    WORKSPACE_CLEANUP_POLICY_MAX_DAYS,
    Math.max(WORKSPACE_CLEANUP_POLICY_MIN_DAYS, Math.round(value))
  )
}

function includesValue<T extends string>(values: readonly T[], value: unknown): value is T {
  return values.some((entry) => entry === value)
}

/** Repairs each field on its own; a missing or invalid field takes its off-by-default value. */
export function normalizeWorkspaceCleanupRules(value: unknown): WorkspaceCleanupRules {
  const defaults = getDefaultWorkspaceCleanupRules()
  const merged = readRule(value, 'merged')
  const unchanged = readRule(value, 'unchanged')
  const inactive = readRule(value, 'inactive')
  const automationRuns = readRule(value, 'automationRuns')
  const orchestrationWorkers = readRule(value, 'orchestrationWorkers')
  const keepWhen = isRecord(value) ? value.keepWhen : undefined
  return {
    merged: { enabled: normalizeEnabled(merged.enabled, defaults.merged.enabled) },
    unchanged: {
      enabled: normalizeEnabled(unchanged.enabled, defaults.unchanged.enabled),
      afterDays: normalizeDays(unchanged.afterDays, defaults.unchanged.afterDays)
    },
    inactive: {
      enabled: normalizeEnabled(inactive.enabled, defaults.inactive.enabled),
      afterDays: normalizeDays(inactive.afterDays, defaults.inactive.afterDays),
      action: includesValue(WORKSPACE_CLEANUP_INACTIVE_ACTIONS, inactive.action)
        ? inactive.action
        : defaults.inactive.action
    },
    automationRuns: {
      enabled: normalizeEnabled(automationRuns.enabled, defaults.automationRuns.enabled)
    },
    orchestrationWorkers: {
      enabled: normalizeEnabled(orchestrationWorkers.enabled, defaults.orchestrationWorkers.enabled)
    },
    keepWhen: includesValue(WORKSPACE_CLEANUP_KEEP_WHEN_VALUES, keepWhen)
      ? keepWhen
      : defaults.keepWhen
  }
}

export function normalizeRepoWorkspaceCleanupPolicy(
  value: unknown
): RepoWorkspaceCleanupPolicy | undefined {
  if (!isRecord(value)) {
    return undefined
  }
  if (value.mode === 'off') {
    return { mode: 'off' }
  }
  if (value.mode === 'custom') {
    return { mode: 'custom', rules: normalizeWorkspaceCleanupRules(value.rules) }
  }
  return undefined
}

function withEveryRuleOff(rules: WorkspaceCleanupRules): WorkspaceCleanupRules {
  return {
    merged: { enabled: false },
    unchanged: { ...rules.unchanged, enabled: false },
    inactive: { ...rules.inactive, enabled: false },
    automationRuns: { enabled: false },
    orchestrationWorkers: { enabled: false },
    keepWhen: rules.keepWhen
  }
}

function withArchiveSupport(
  source: ResolvedWorkspaceCleanupPolicy['source'],
  rules: WorkspaceCleanupRules
): ResolvedWorkspaceCleanupPolicy {
  return {
    source,
    rules,
    inactiveActionSupported: rules.inactive.action !== 'archive' || WORKSPACE_ARCHIVE_SUPPORTED
  }
}

/** The one place that decides which cleanup rules apply to a project's workspaces. Inputs are store-normalized. */
export function resolveWorkspaceCleanupPolicy(
  settings: { workspaceCleanupPolicy?: WorkspaceCleanupRules },
  repo: { workspaceCleanupPolicy?: RepoWorkspaceCleanupPolicy } | null | undefined
): ResolvedWorkspaceCleanupPolicy {
  // Absent only on settings objects built before load normalization ran.
  const globalRules = settings.workspaceCleanupPolicy ?? getDefaultWorkspaceCleanupRules()
  const override = repo?.workspaceCleanupPolicy
  if (override?.mode === 'custom') {
    return withArchiveSupport('project-custom', override.rules)
  }
  if (override?.mode === 'off') {
    return withArchiveSupport('project-off', withEveryRuleOff(globalRules))
  }
  return withArchiveSupport('global', globalRules)
}
