// Wire contract between the desktop and the Orca sandbox control plane (cloud/apps/sandbox-control).
// The Worker's tests parse its responses with these schemas, so either side drifting fails a test.
import { z } from 'zod'

export const HOSTED_SANDBOX_MACHINE_SIZES = ['standard', 'large', 'xlarge'] as const
export type HostedSandboxMachineSize = (typeof HOSTED_SANDBOX_MACHINE_SIZES)[number]

export const HOSTED_SANDBOX_STATUSES = [
  'creating',
  'running',
  'suspending',
  'suspended',
  'resuming',
  'destroying',
  'destroyed',
  'failed'
] as const
export type HostedSandboxStatus = (typeof HOSTED_SANDBOX_STATUSES)[number]

export const HOSTED_SANDBOX_ERROR_CODES = [
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'entitlement_denied',
  'invalid_request',
  'invalid_json',
  'billing_unavailable',
  'provider_unavailable',
  'not_configured',
  'internal_error'
] as const
export type HostedSandboxErrorCode = (typeof HOSTED_SANDBOX_ERROR_CODES)[number]

const Id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_.:-]+$/)
const Millis = z.number().int().nonnegative()

export const HostedSandboxSessionSchema = z
  .object({
    id: Id,
    startedAt: Millis,
    deadlineAt: Millis,
    leaseExpiresAt: Millis
  })
  .strict()

export const HostedSandboxViewSchema = z
  .object({
    id: Id,
    workspaceId: Id,
    status: z.enum(HOSTED_SANDBOX_STATUSES),
    machineSize: z.enum(HOSTED_SANDBOX_MACHINE_SIZES),
    region: z.string().min(1).max(32),
    session: HostedSandboxSessionSchema.nullable(),
    createdAt: Millis
  })
  .strict()
export type HostedSandboxView = z.infer<typeof HostedSandboxViewSchema>

export const HostedSandboxConnectionSchema = z
  .object({
    type: z.literal('orca-server'),
    pairingCode: z.string().min(1).max(8192),
    projectRoot: z.string().startsWith('/').max(4096)
  })
  .strict()

export const HostedSandboxCreateRequestSchema = z
  .object({
    workspaceId: Id,
    machineSize: z.enum(HOSTED_SANDBOX_MACHINE_SIZES),
    region: z
      .string()
      .regex(/^[a-z]{3}[0-9]$/)
      .optional(),
    repo: z
      .object({
        url: z.url({ protocol: /^https$/ }).max(2048),
        ref: z.string().min(1).max(255).optional()
      })
      .strict()
      .optional()
  })
  .strict()
export type HostedSandboxCreateRequest = z.infer<typeof HostedSandboxCreateRequestSchema>

export const HostedSandboxLeaseRequestSchema = z
  .object({
    extendMs: z
      .number()
      .int()
      .min(60_000)
      .max(60 * 60_000)
  })
  .strict()

/** create, resume and rollover: the environment is up and orcad is ready to pair. */
export const HostedSandboxReadyResponseSchema = z
  .object({ sandbox: HostedSandboxViewSchema, connection: HostedSandboxConnectionSchema })
  .strict()
export type HostedSandboxReadyResponse = z.infer<typeof HostedSandboxReadyResponseSchema>

export const HostedSandboxStatusResponseSchema = z
  .object({ sandbox: HostedSandboxViewSchema })
  .strict()

export const HostedSandboxListResponseSchema = z
  .object({ sandboxes: z.array(HostedSandboxViewSchema).max(1000) })
  .strict()

export const HostedSandboxErrorResponseSchema = z
  .object({
    error: z.enum(HOSTED_SANDBOX_ERROR_CODES),
    reason: z.string().max(64).optional()
  })
  .strict()
