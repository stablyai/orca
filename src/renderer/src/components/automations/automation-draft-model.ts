import { getAgentCatalog } from '@/lib/agent-catalog'
import type { AutomationPrecheck } from '../../../../shared/automations-types'
import { buildAutomationCronSchedule } from '../../../../shared/automation-schedules'
import type { Worktree } from '../../../../shared/worktree/types'
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

export function getAgentLabel(agentId: string): string {
  return getAgentCatalog().find((agent) => agent.id === agentId)?.label ?? agentId
}
