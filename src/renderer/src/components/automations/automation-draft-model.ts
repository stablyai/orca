import { getAgentCatalog } from '@/lib/agent-catalog'
import { translate } from '@/i18n/i18n'
import type { AutomationPrecheck } from '../../../../shared/automations-types'
import { buildAutomationCronSchedule } from '../../../../shared/automation-schedules'
import { isTuiAgent } from '../../../../shared/tui-agent-config'
import type { TuiAgent, Worktree } from '../../../../shared/types'
import type { AutomationDraft } from './AutomationEditorDialog'

export const AUTOMATION_DEFAULT_TIME = '09:00'

export function getDefaultWorktree(worktrees: readonly Worktree[]): Worktree | null {
  return worktrees.find((worktree) => worktree.isMainWorktree) ?? worktrees[0] ?? null
}

export function formatTimeInput(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

export function parseDraftTime(time: string): { hour: number; minute: number } {
  const [rawHour, rawMinute] = time.split(':').map((part) => Number(part))
  return {
    hour: Number.isInteger(rawHour) && rawHour >= 0 && rawHour <= 23 ? rawHour : 9,
    minute: Number.isInteger(rawMinute) && rawMinute >= 0 && rawMinute <= 59 ? rawMinute : 0
  }
}

export function buildDraftPrecheck(draft: AutomationDraft): AutomationPrecheck | null {
  const command = draft.precheckCommand.trim()
  if (!command) {
    return null
  }
  const rawTimeout = Number(draft.precheckTimeoutSeconds)
  return {
    command,
    timeoutSeconds: Number.isFinite(rawTimeout) ? rawTimeout : 60
  }
}

export function buildHermesCronSchedule(draft: AutomationDraft): string {
  if (draft.preset === 'custom') {
    return draft.customSchedule.trim()
  }
  const { hour, minute } = parseDraftTime(draft.time)
  return buildAutomationCronSchedule({
    preset: draft.preset,
    hour,
    minute,
    dayOfWeek: Number(draft.dayOfWeek)
  })
}

/** Why: a mixed-version host can still hand back a retired id, which is not in
 *  the union any dialog or save-refine accepts — treat it like a cleared agent. */
export function resolveDraftAgentId(agentId: unknown, defaultAgent: TuiAgent): TuiAgent {
  return isTuiAgent(agentId) ? agentId : defaultAgent
}

export function getAgentLabel(agentId: string | null): string {
  if (!agentId) {
    // A retired-agent cleanup cleared it; the user has to pick a replacement.
    return translate('auto.components.automations.automation.draft.model.a0f61bd7c9', 'No agent')
  }
  return getAgentCatalog().find((agent) => agent.id === agentId)?.label ?? agentId
}
