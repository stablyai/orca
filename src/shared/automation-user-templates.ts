import { normalizeAutomationAgentConfig } from './automation-agent-config'
import type {
  AutomationSchedulePreset,
  UserAutomationTemplate,
  UserAutomationTemplateInput
} from './automations-types'
import { isTuiAgent } from './tui-agent-config'

const SCHEDULE_PRESETS: readonly AutomationSchedulePreset[] = [
  'hourly',
  'daily',
  'weekdays',
  'weekly',
  'custom'
]

function normalizePreset(value: unknown): AutomationSchedulePreset {
  return SCHEDULE_PRESETS.includes(value as AutomationSchedulePreset)
    ? (value as AutomationSchedulePreset)
    : 'daily'
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

// Why: IPC input is typed but not validated at runtime, so coerce any non-string
// to '' rather than throw a TypeError on `.trim()` inside an ipcMain handler.
function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** Apply input onto a base template (or defaults for a fresh create). Shared by
 *  create and update so both produce identical canonical records. */
export function buildUserAutomationTemplate(
  input: UserAutomationTemplateInput,
  base: Pick<UserAutomationTemplate, 'id' | 'createdAt'> & { now: number }
): UserAutomationTemplate {
  return {
    id: base.id,
    label: asString(input.label).trim() || 'Untitled template',
    description: asString(input.description).trim(),
    name: asString(input.name).trim(),
    prompt: asString(input.prompt),
    // Why: an unknown agent id would render a broken picker entry, so fall back
    // to the default Claude agent rather than persist a dangling reference.
    agentId: isTuiAgent(input.agentId) ? input.agentId : 'claude',
    agentConfig: normalizeAutomationAgentConfig(input.agentConfig),
    preset: normalizePreset(input.preset),
    time: optionalString(input.time),
    dayOfWeek: optionalString(input.dayOfWeek),
    customSchedule: optionalString(input.customSchedule),
    missedRunGraceMinutes: optionalString(input.missedRunGraceMinutes),
    createdAt: base.createdAt,
    updatedAt: base.now
  }
}

/** Normalize a stored/loaded template, dropping anything structurally invalid.
 *  Returns null when the value cannot be a template so callers can filter it. */
export function normalizeUserAutomationTemplate(value: unknown): UserAutomationTemplate | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const record = value as Partial<UserAutomationTemplate>
  if (typeof record.id !== 'string' || !record.id) {
    return null
  }
  const createdAt = typeof record.createdAt === 'number' ? record.createdAt : 0
  return buildUserAutomationTemplate(
    {
      label: typeof record.label === 'string' ? record.label : '',
      description: typeof record.description === 'string' ? record.description : '',
      name: typeof record.name === 'string' ? record.name : '',
      prompt: typeof record.prompt === 'string' ? record.prompt : '',
      agentId: record.agentId ?? 'claude',
      agentConfig: record.agentConfig ?? null,
      preset: record.preset ?? 'daily',
      time: record.time ?? null,
      dayOfWeek: record.dayOfWeek ?? null,
      customSchedule: record.customSchedule ?? null,
      missedRunGraceMinutes: record.missedRunGraceMinutes ?? null
    },
    {
      id: record.id,
      createdAt,
      now: typeof record.updatedAt === 'number' ? record.updatedAt : createdAt
    }
  )
}
