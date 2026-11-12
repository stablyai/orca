import { z } from 'zod'
import { isValidAutomationSchedule } from '../../automations/scheduling/automation-schedule-parsing'
import {
  PLUGIN_HOST_ID_MAX_LENGTH,
  PLUGIN_HOST_TEXT_MAX_LENGTH,
  pluginAgentSchema,
  pluginLabelNameSchema,
  pluginWorkspaceIdSchema
} from './plugin-host-api-workspace-methods'
import { spec, WORKER_ONLY } from './plugin-host-method-spec'

/** Host API 1.8: the person's automations on this Orca, as `orca automations` reads and writes
 *  them. Plugin-created ones record the plugin, which Orca's Automations page shows. */

export const PLUGIN_AUTOMATION_LIST_LIMIT = 200
export const PLUGIN_AUTOMATION_PROMPT_MAX = 16_384
export const PLUGIN_AUTOMATION_SCHEDULE_MAX = 2048
const ID_MAX = PLUGIN_HOST_ID_MAX_LENGTH

const automationId = z.string().min(1).max(ID_MAX)
const prompt = z
  .string()
  .max(PLUGIN_AUTOMATION_PROMPT_MAX)
  .refine((text) => text.trim().length > 0, 'prompt must not be blank')
/** An RRULE such as `FREQ=DAILY;BYHOUR=9;BYMINUTE=0`, or a five-field cron expression. */
const schedule = z
  .string()
  .min(1)
  .max(PLUGIN_AUTOMATION_SCHEDULE_MAX)
  .refine(isValidAutomationSchedule, 'schedule must be an RRULE or a cron expression')
/** An IANA time zone such as `Europe/Berlin`; Orca's own when absent. */
const timezone = z.string().min(1).max(64).refine(isTimeZone, 'unknown time zone')

function isTimeZone(zone: string): boolean {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone !== ''
  } catch {
    return false
  }
}

const automationListParams = z.strictObject({}).optional()
const automationRow = z.object({
  id: automationId,
  name: z.string().max(512),
  agent: z.string().max(64),
  /** Cut to 4096 characters; `promptTruncated` says when. */
  prompt: z.string().max(PLUGIN_HOST_TEXT_MAX_LENGTH),
  promptTruncated: z.boolean(),
  /** Its project, as `project.list` gives its id. */
  projectId: z.string().max(ID_MAX).nullable(),
  /** The host its runs use; null for this machine on automations that record none. */
  hostId: z.string().max(ID_MAX).nullable(),
  /** The workspace each run uses, as `workspace.list` gives its id; null for `new-per-run`. */
  workspaceId: z.string().max(ID_MAX).nullable(),
  /** `new-per-run`: each run creates a workspace in the project. */
  workspaceMode: z.enum(['existing', 'new-per-run']),
  schedule: z.string().max(PLUGIN_AUTOMATION_SCHEDULE_MAX),
  timezone: z.string().max(64),
  enabled: z.boolean(),
  /** Milliseconds since the epoch; null when it will not run (paused). */
  nextRunAt: z.number().finite().nullable(),
  lastRunAt: z.number().finite().nullable(),
  /** This plugin created it, so it may change or delete it without asking. */
  createdByThisPlugin: z.boolean()
})
const automationListResult = z.object({
  automations: z.array(automationRow).max(PLUGIN_AUTOMATION_LIST_LIMIT),
  /** More automations exist than the list holds. */
  truncated: z.boolean()
})

const automationCreateParams = z
  .strictObject({
    name: pluginLabelNameSchema,
    /** What the agent is asked each run. */
    prompt,
    agent: pluginAgentSchema,
    /** Each run creates a workspace in this project (`project.list` id); give this or `workspaceId`. */
    projectId: z.string().min(1).max(ID_MAX).optional(),
    /** Each run uses this workspace (`workspace.list` id), which also names its host. */
    workspaceId: pluginWorkspaceIdSchema.optional(),
    schedule,
    timezone: timezone.optional(),
    /** Default true. */
    enabled: z.boolean().optional()
  })
  .refine(
    (params) => (params.projectId === undefined) !== (params.workspaceId === undefined),
    'give exactly one of projectId and workspaceId'
  )
const automationCreateResult = z.object({ automationId })

/** Absent when Orca asked the person: `cancelled`, they said no; `consent-unavailable`, nobody
 *  could be asked (Orca's window is hidden, or headless). */
const refusal = z.enum(['cancelled', 'consent-unavailable']).optional()
const automationUpdateParams = z
  .strictObject({
    automationId,
    name: pluginLabelNameSchema.optional(),
    prompt: prompt.optional(),
    schedule: schedule.optional(),
    timezone: timezone.optional(),
    enabled: z.boolean().optional()
  })
  .refine(
    (params) =>
      Object.entries(params).some(([key, value]) => key !== 'automationId' && value !== undefined),
    'nothing to change'
  )
const automationUpdateResult = z.object({ updated: z.boolean(), reason: refusal })
const automationDeleteParams = z.strictObject({ automationId })
const automationDeleteResult = z.object({ deleted: z.boolean(), reason: refusal })

const CONFIRMS =
  'Orca first asks the person about an automation this plugin did not create (or created before it was removed or disabled); if they decline or cannot be asked, nothing changes and `reason` says why.'

export const PLUGIN_AUTOMATION_API = {
  'automation.list': spec({
    summary:
      "Lists the automations this Orca schedules, at most 200, with each one's prompt cut to 4096 characters.",
    since: 8,
    scope: 'any-workspace',
    capability: 'automation:read',
    mutation: false,
    surfaces: WORKER_ONLY,
    params: automationListParams,
    result: automationListResult
  }),
  'automation.create': spec({
    summary:
      "Creates an automation that starts `agent` with `prompt` on `schedule`, even when the plugin is not running, with the person's settings for that agent; Orca's Automations page shows it as created by the plugin.",
    since: 8,
    scope: 'any-workspace',
    capability: 'automation:write',
    mutation: true,
    surfaces: WORKER_ONLY,
    params: automationCreateParams,
    result: automationCreateResult
  }),
  'automation.update': spec({
    summary: `Changes an automation's name, prompt, schedule, time zone or whether it is enabled. ${CONFIRMS} Orca also asks before a new prompt or schedule, or resuming, for any automation whose runs use extra agent settings the person chose.`,
    since: 8,
    scope: 'any-workspace',
    capability: 'automation:write',
    mutation: true,
    surfaces: WORKER_ONLY,
    params: automationUpdateParams,
    result: automationUpdateResult
  }),
  'automation.delete': spec({
    summary: `Deletes an automation. ${CONFIRMS}`,
    since: 8,
    scope: 'any-workspace',
    capability: 'automation:write',
    mutation: true,
    surfaces: WORKER_ONLY,
    params: automationDeleteParams,
    result: automationDeleteResult
  })
}
