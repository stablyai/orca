// Codex tokens often omit workspace_name; the saved workspace label then names the token's plan.
const PLAN_WORKSPACE_LABELS = new Map([
  ['free', 'Personal (Free)'],
  ['go', 'Personal (Go)'],
  ['plus', 'Personal (Plus)'],
  ['pro', 'Personal (Pro)'],
  ['team', 'Team'],
  ['business', 'Business'],
  ['enterprise', 'Enterprise'],
  ['edu', 'Education']
])

const PLAN_WORKSPACE_LABEL_VALUES = new Set(PLAN_WORKSPACE_LABELS.values())

export function codexPlanWorkspaceLabel(planType: string | null | undefined): string | null {
  return (planType && PLAN_WORKSPACE_LABELS.get(planType.toLowerCase())) || null
}

/** A label that may stand for a plan rather than a workspace; a saved label cannot say which. */
export function isCodexPlanWorkspaceLabel(label: string | null | undefined): boolean {
  return PLAN_WORKSPACE_LABEL_VALUES.has(label?.trim() ?? '')
}
