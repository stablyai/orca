import type { WslDaemonRecovery } from './wsl-daemon-recovery'
import { z } from 'zod'
import type { WslPtyOwner } from './wsl-pty-id'

const identity = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => !/[\0\r\n]/.test(value))
const guestPath = identity.refine((value) => value.startsWith('/'))
const endpointSchema = z.object({
  distro: identity,
  distributionId: identity,
  userId: z.string().regex(/^\d+$/),
  userName: identity,
  serverBuildId: identity,
  envBinary: guestPath,
  runtime: guestPath,
  entry: guestPath,
  socket: guestPath,
  credentialFile: guestPath
})

const recoverySchema = z.object({
  distro: identity,
  relayBuildId: identity,
  clientInstanceId: identity,
  clientGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  ownerGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  ownerLease: z.string().min(1).max(4096),
  endpoint: endpointSchema.optional(),
  outputFlowControl: z
    .object({
      version: z.literal(1),
      windowSu: z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
    })
    .optional()
})

export type PersistedWslRelayEndpoint = z.infer<typeof endpointSchema>

export function normalizePersistedWslRelayEndpoint(
  value: unknown
): PersistedWslRelayEndpoint | null {
  const parsed = endpointSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

export type WslPtyConsumerRecovery = z.infer<typeof recoverySchema>

export function normalizeWslPtyConsumerRecovery(
  value: unknown,
  encrypted = false
): WslPtyConsumerRecovery | null {
  const parsed = recoverySchema.safeParse(value)
  return parsed.success && (encrypted || parsed.data.ownerLease.length <= 512) ? parsed.data : null
}

export function wslPtyOwnerKey(owner: WslPtyOwner): string {
  return `${encodeURIComponent(owner.distro)}@@${encodeURIComponent(owner.relayBuildId)}`
}

export type WslPtyRecoveryRecord = WslPtyConsumerRecovery | WslDaemonRecovery

export function isWslDaemonRecovery(record: WslPtyRecoveryRecord): record is WslDaemonRecovery {
  return 'kind' in record && record.kind === 'daemon'
}
