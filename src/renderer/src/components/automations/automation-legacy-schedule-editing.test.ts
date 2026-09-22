import { describe, expect, it } from 'vitest'
import type { Automation } from '../../../../shared/automations-types'
import {
  isRunnableAutomationSchedule,
  isValidAutomationSchedule
} from '../../../../shared/automation-schedule-parsing'
import { buildAutomationEditDraft } from './automation-edit-draft'
import { getCronScheduleStatusLabel } from './AutomationCustomCronPanel'
import { acceptsAutomationDraftSchedule } from './automation-schedule-input-gate'

// `*/90` on minutes was accepted before the oversized-step refusal (#15895) and still runs,
// firing at :00. Only a row persisted by an older build can hold it.
const LEGACY_OVERSIZED_STEP = '*/90 * * * *'

const makeAutomation = (overrides: Partial<Automation> = {}): Automation => ({
  id: 'a1',
  name: 'Nightly sweep',
  prompt: 'Check the repo',
  precheck: null,
  agentId: 'claude',
  projectId: 'r1',
  executionTargetType: 'local',
  executionTargetId: 'local',
  schedulerOwner: 'local_host_service',
  workspaceMode: 'existing',
  workspaceId: 'wt1',
  baseBranch: null,
  reuseSession: false,
  timezone: 'UTC',
  rrule: LEGACY_OVERSIZED_STEP,
  dtstart: 0,
  enabled: true,
  nextRunAt: 0,
  missedRunPolicy: 'run_once_within_grace',
  missedRunGraceMinutes: 720,
  createdAt: 0,
  updatedAt: 0,
  ...overrides
})

describe('editing an automation whose saved schedule predates the input gate', () => {
  it('still refuses the same expression as new input', () => {
    expect(isValidAutomationSchedule(LEGACY_OVERSIZED_STEP)).toBe(false)
    expect(isRunnableAutomationSchedule(LEGACY_OVERSIZED_STEP)).toBe(true)
  })

  it('opens the editor with the saved schedule intact and no warning', () => {
    const draft = buildAutomationEditDraft(makeAutomation())
    expect(draft.preset).toBe('custom')
    expect(draft.customSchedule).toBe(LEGACY_OVERSIZED_STEP)
    expect(draft.scheduleWarning).toBeNull()
  })

  // The regression this guards: a rename was blocked behind re-authoring a schedule the
  // user never touched and that is still firing.
  it('lets a rename through without re-authoring the schedule', () => {
    const automation = makeAutomation()
    const renamed = { ...buildAutomationEditDraft(automation), name: 'Renamed sweep' }
    expect(renamed.scheduleWarning).toBeNull()
    expect(
      acceptsAutomationDraftSchedule({
        customSchedule: renamed.customSchedule,
        savedRrule: automation.rrule,
        validate: isValidAutomationSchedule
      })
    ).toBe(true)
  })

  it('still refuses a schedule the user actually changes', () => {
    const automation = makeAutomation()
    for (const edited of ['*/91 * * * *', '0 */25 * * *', 'nonsense']) {
      expect(
        acceptsAutomationDraftSchedule({
          customSchedule: edited,
          savedRrule: automation.rrule,
          validate: isValidAutomationSchedule
        })
      ).toBe(false)
    }
  })

  it('refuses an oversized step on a new automation, which has nothing saved', () => {
    expect(
      acceptsAutomationDraftSchedule({
        customSchedule: LEGACY_OVERSIZED_STEP,
        savedRrule: null,
        validate: isValidAutomationSchedule
      })
    ).toBe(false)
  })

  // The editor's live cron status runs the same gate, so an untouched legacy cadence is not
  // painted red with "fix this before saving" for a rule it only owes as new input.
  it('reports the saved schedule as valid in the editor cron status', () => {
    const draft = buildAutomationEditDraft(makeAutomation())
    const accepts = (schedule: string): boolean =>
      acceptsAutomationDraftSchedule({
        customSchedule: schedule,
        savedRrule: draft.savedSchedule,
        validate: isValidAutomationSchedule
      })
    expect(getCronScheduleStatusLabel(draft.customSchedule, accepts).kind).toBe('valid')
    // A different oversized step is new input, so it is still called out.
    expect(getCronScheduleStatusLabel('*/91 * * * *', accepts).kind).toBe('invalid')
  })

  it('carries the saved schedule on the draft so the gate can see it', () => {
    expect(buildAutomationEditDraft(makeAutomation()).savedSchedule).toBe(LEGACY_OVERSIZED_STEP)
  })

  // Leniency is scoped to the oversized-step gate; a schedule that cannot parse at all is
  // still unrepresentable and must keep warning rather than silently round-trip.
  it('keeps warning about a saved schedule that cannot be parsed', () => {
    const draft = buildAutomationEditDraft(makeAutomation({ rrule: '0 9 32 * *' }))
    expect(draft.customSchedule).toBe('')
    expect(draft.scheduleWarning).toBeTruthy()
  })
})
