import { z } from 'zod'

export const INITIAL_WORKER_ROLE_NAMES = ['research', 'implementation', 'review'] as const

export const WorkerRoleName = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,47}$/, 'Invalid worker role name')
  .refine(
    (name) => !['constructor', 'prototype', '__proto__'].includes(name),
    'Invalid worker role name'
  )

const ProfileString = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => value === value.trim(), 'Surrounding whitespace is invalid')

export const WorkerRoleProfileSchema = z
  .object({
    agent: ProfileString,
    model: ProfileString.optional(),
    effort: ProfileString.optional(),
    fastMode: z.boolean().optional()
  })
  .strict()

const WorkerRoleProfilesSchema = z
  .record(WorkerRoleName, WorkerRoleProfileSchema)
  .refine((profiles) => Object.keys(profiles).length <= 24, 'At most 24 worker roles are supported')

export type WorkerRoleProfile = z.infer<typeof WorkerRoleProfileSchema>
export type WorkerRoleProfiles = Record<string, WorkerRoleProfile>
export type WorkerRoleSettings = { orchestrationWorkerRoles?: WorkerRoleProfiles }

export function parseWorkerRoleProfiles(value: unknown): WorkerRoleProfiles {
  return WorkerRoleProfilesSchema.parse(value ?? {})
}

type WorkerRoleParams = {
  role?: string
  agent?: string
  model?: string
  effort?: string
  fastMode?: boolean
  terminal?: string
}

export function resolveWorkerRoleParams<T extends WorkerRoleParams>(
  params: T,
  profiles: unknown
): T & WorkerRoleParams {
  if (!params.role) {
    return params
  }
  WorkerRoleName.parse(params.role)
  if (params.terminal) {
    throw new Error('--role cannot be applied to an existing --terminal.')
  }
  const configured = parseWorkerRoleProfiles(profiles)
  const profile = Object.hasOwn(configured, params.role) ? configured[params.role] : undefined
  if (!profile) {
    throw new Error(`Worker role ${params.role} is not configured in Agent Orchestration settings.`)
  }
  const inherited: Partial<WorkerRoleProfile> =
    params.agent && params.agent !== profile.agent ? {} : profile
  return {
    ...params,
    agent: params.agent ?? profile.agent,
    model: params.model ?? inherited.model,
    effort: params.effort ?? inherited.effort,
    fastMode: params.fastMode ?? inherited.fastMode
  }
}

export function sanitizeWorkerRoleProfileUpdates(
  target: Partial<WorkerRoleSettings>,
  updates: Partial<WorkerRoleSettings>
): void {
  if ('orchestrationWorkerRoles' in updates) {
    target.orchestrationWorkerRoles = parseWorkerRoleProfiles(updates.orchestrationWorkerRoles)
  }
}
