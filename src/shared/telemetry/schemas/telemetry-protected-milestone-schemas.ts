import { z } from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'
import { agentKindSchema } from './telemetry-property-schemas'

// Frozen at first profile load on a build that tracks milestones; a new profile is not proof of a new machine.
export const milestoneInstallCohortSchema = lazyZodSchema(() => z.enum(['fresh', 'existing']))
export type MilestoneInstallCohort = z.infer<typeof milestoneInstallCohortSchema>

// unattributed_prompt: a hook saw a submitted prompt but cannot prove a person, not automation, typed it.
export const firstAgentInteractionSourceSchema = lazyZodSchema(() =>
  z.enum(['orca_send', 'native_chat', 'mobile_chat', 'unattributed_prompt'])
)
export type FirstAgentInteractionSource = z.infer<typeof firstAgentInteractionSourceSchema>

// terminal_input: genuine xterm user input admitted by a local/remote transport, including buffered input; never its bytes.
export const meaningfulActivityTriggerSchema = lazyZodSchema(() =>
  z.enum([
    'agent_started',
    'orca_send',
    'native_chat',
    'mobile_chat',
    'workspace_created',
    'terminal_input'
  ])
)
export type MeaningfulActivityTrigger = z.infer<typeof meaningfulActivityTriggerSchema>

// Observed prompt/message submission, never inferred from a launch or provider outcome.
export const firstAgentInteractionSchema = lazyZodSchema(() =>
  z
    .object({
      source: firstAgentInteractionSourceSchema,
      agent_kind: agentKindSchema,
      install_cohort: milestoneInstallCohortSchema
    })
    .strict()
)

export const meaningfulActivityDaySchema = lazyZodSchema(() =>
  z
    .object({
      trigger: meaningfulActivityTriggerSchema,
      install_cohort: milestoneInstallCohortSchema
    })
    .strict()
)
