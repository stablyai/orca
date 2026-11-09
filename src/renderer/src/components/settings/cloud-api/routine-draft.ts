// The routine editor's form state and its translation to/from the /v1/routines contract. Pure.
import { buildAutomationCronSchedule } from '../../../../../shared/automations/scheduling/automation-schedule-occurrences'
import { classifyAutomationCronSchedule } from '../../../../../shared/automations/scheduling/automation-schedules'
import { isValidAutomationCronSchedule } from '../../../../../shared/automations/scheduling/automation-schedule-parsing'
import {
  RoutineInputSchema,
  type Routine,
  type RoutineAgent,
  type RoutineGithubEvent,
  type RoutineInput,
  type RoutinePostResults,
  type RoutineTriggerInput
} from '../../../../../shared/cloud-api/cloud-api-types'

export type RoutineSchedulePreset = 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'custom'
export type RoutineTriggerKind = RoutineTriggerInput['kind']

export type RoutineDraft = {
  name: string
  source: 'project' | 'repo'
  projectId: string
  repoUrl: string
  repoRef: string
  triggerKind: RoutineTriggerKind
  schedulePreset: RoutineSchedulePreset
  /** HH:MM, 24h. */
  time: string
  dayOfWeek: number
  customCron: string
  timezone: string
  githubEvents: RoutineGithubEvent[]
  labels: string
  authors: string
  baseBranches: string
  agent: RoutineAgent
  prompt: string
  postResults: RoutinePostResults
  maxRuntimeMinutes: string
  enabled: boolean
}

export type RoutineDraftField =
  | 'name'
  | 'source'
  | 'repoUrl'
  | 'customCron'
  | 'githubEvents'
  | 'prompt'
  | 'maxRuntimeMinutes'

export const DEFAULT_ROUTINE_MAX_RUNTIME_MINUTES = 30

export function emptyRoutineDraft(timezone: string): RoutineDraft {
  return {
    name: '',
    source: 'repo',
    projectId: '',
    repoUrl: '',
    repoRef: '',
    triggerKind: 'schedule',
    schedulePreset: 'weekdays',
    time: '09:00',
    dayOfWeek: 1,
    customCron: '',
    timezone,
    githubEvents: ['pull_request.labeled'],
    labels: 'orca',
    authors: '',
    baseBranches: '',
    agent: 'claude',
    prompt: '',
    postResults: 'comment',
    maxRuntimeMinutes: String(DEFAULT_ROUTINE_MAX_RUNTIME_MINUTES),
    enabled: true
  }
}

const pad = (value: number): string => String(value).padStart(2, '0')

export function routineDraftFromRoutine(routine: Routine, fallbackTimezone: string): RoutineDraft {
  const draft = emptyRoutineDraft(fallbackTimezone)
  const trigger = routine.trigger
  const base: RoutineDraft = {
    ...draft,
    name: routine.name,
    source: routine.projectId ? 'project' : 'repo',
    projectId: routine.projectId ?? '',
    repoUrl: routine.repo?.url ?? '',
    repoRef: routine.repo?.ref ?? '',
    triggerKind: trigger.kind,
    agent: routine.agent,
    prompt: routine.prompt,
    postResults: routine.postResults,
    maxRuntimeMinutes: routine.maxRuntimeMinutes ? String(routine.maxRuntimeMinutes) : '',
    enabled: routine.enabled
  }
  if (trigger.kind === 'schedule') {
    const shape = classifyAutomationCronSchedule(trigger.cron)
    const withTz = { ...base, timezone: trigger.timezone }
    if (shape.kind === 'hourly') {
      return { ...withTz, schedulePreset: 'hourly', time: `00:${pad(shape.minute)}` }
    }
    if (shape.kind === 'daily' || shape.kind === 'weekdays' || shape.kind === 'weekly') {
      return {
        ...withTz,
        schedulePreset: shape.kind,
        time: `${pad(shape.hour)}:${pad(shape.minute)}`,
        dayOfWeek: shape.kind === 'weekly' ? shape.dayOfWeek : draft.dayOfWeek
      }
    }
    return { ...withTz, schedulePreset: 'custom', customCron: trigger.cron }
  }
  if (trigger.kind === 'github') {
    return {
      ...base,
      githubEvents: [...trigger.events],
      labels: (trigger.labels ?? []).join(', '),
      authors: (trigger.authors ?? []).join(', '),
      baseBranches: (trigger.baseBranches ?? []).join(', ')
    }
  }
  return base
}

export function routineDraftCron(draft: RoutineDraft): string {
  if (draft.schedulePreset === 'custom') {
    return draft.customCron.trim()
  }
  const [hour, minute] = draft.time.split(':').map(Number)
  return buildAutomationCronSchedule({
    preset: draft.schedulePreset,
    hour: hour ?? 9,
    minute: minute ?? 0,
    dayOfWeek: draft.dayOfWeek
  })
}

function list(value: string): string[] | undefined {
  const items = [
    ...new Set(
      value
        .split(/[,\n]/)
        .map((item) => item.trim().replace(/^@/, ''))
        .filter(Boolean)
    )
  ]
  return items.length > 0 ? items : undefined
}

function triggerOf(draft: RoutineDraft): RoutineTriggerInput {
  if (draft.triggerKind === 'schedule') {
    return { kind: 'schedule', cron: routineDraftCron(draft), timezone: draft.timezone }
  }
  if (draft.triggerKind === 'github') {
    const labels = list(draft.labels)
    const authors = list(draft.authors)
    const baseBranches = list(draft.baseBranches)
    return {
      kind: 'github',
      events: draft.githubEvents,
      ...(labels ? { labels } : {}),
      ...(authors ? { authors } : {}),
      ...(baseBranches ? { baseBranches } : {})
    }
  }
  return { kind: 'webhook' }
}

export type RoutineDraftValidation =
  | { ok: true; input: RoutineInput }
  | { ok: false; errors: Partial<Record<RoutineDraftField, string>> }

/** Field-level problems use stable codes; the editor words them. */
export function validateRoutineDraft(draft: RoutineDraft): RoutineDraftValidation {
  const errors: Partial<Record<RoutineDraftField, string>> = {}
  if (!draft.name.trim()) {
    errors.name = 'required'
  }
  if (draft.source === 'project' && !draft.projectId) {
    errors.source = 'required'
  }
  if (draft.source === 'repo') {
    const url = draft.repoUrl.trim()
    if (!url) {
      errors.repoUrl = 'required'
    } else if (!/^https:\/\/[^\s/]+\/[^\s]+$/.test(url)) {
      errors.repoUrl = 'invalid'
    }
  }
  if (draft.triggerKind === 'schedule' && draft.schedulePreset === 'custom') {
    if (!draft.customCron.trim()) {
      errors.customCron = 'required'
    } else if (!isValidAutomationCronSchedule(draft.customCron.trim())) {
      errors.customCron = 'invalid'
    }
  }
  if (draft.triggerKind === 'github' && draft.githubEvents.length === 0) {
    errors.githubEvents = 'required'
  }
  if (!draft.prompt.trim()) {
    errors.prompt = 'required'
  }
  const runtime = draft.maxRuntimeMinutes.trim()
  if (
    runtime &&
    !(Number.isInteger(Number(runtime)) && Number(runtime) >= 1 && Number(runtime) <= 720)
  ) {
    errors.maxRuntimeMinutes = 'invalid'
  }
  if (Object.keys(errors).length > 0) {
    return { ok: false, errors }
  }
  const candidate: RoutineInput = {
    name: draft.name.trim(),
    ...(draft.source === 'project'
      ? { projectId: draft.projectId }
      : {
          repo: {
            url: draft.repoUrl.trim(),
            ...(draft.repoRef.trim() ? { ref: draft.repoRef.trim() } : {})
          }
        }),
    trigger: triggerOf(draft),
    agent: draft.agent,
    prompt: draft.prompt.trim(),
    postResults: draft.postResults,
    enabled: draft.enabled,
    ...(runtime ? { maxRuntimeMinutes: Number(runtime) } : {})
  }
  const parsed = RoutineInputSchema.safeParse(candidate)
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path[0]
    return {
      ok: false,
      errors: {
        [field === 'repo' ? 'repoUrl' : field === 'trigger' ? 'githubEvents' : 'name']: 'invalid'
      }
    }
  }
  return { ok: true, input: parsed.data }
}
