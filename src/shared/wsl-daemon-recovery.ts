import { z } from 'zod'

const identity = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => value.trim() === value && !/[\0\r\n]/.test(value))
const guestPath = identity.refine(
  (value) =>
    value.startsWith('/') &&
    !value.includes('\\') &&
    !value
      .split('/')
      .slice(1)
      .some((part) => part === '.' || part === '..' || part === '')
)
const endpoint = z
  .object({
    distro: identity,
    distributionId: identity,
    userName: identity,
    userId: z.string().regex(/^\d+$/),
    home: guestPath,
    runtime: guestPath,
    entry: guestPath,
    envBinary: guestPath,
    socket: guestPath,
    tokenPath: guestPath,
    serverBuildId: identity,
    protocolVersion: z.number().int().positive().safe().optional()
  })
  .strict()
export const wslDaemonIncarnationSchema = z
  .object({
    pid: z.number().int().positive().safe(),
    startedAtMs: z.number().positive().finite(),
    launchNonce: identity,
    linuxStartTicks: z.string().regex(/^\d+$/),
    bootId: identity
  })
  .strict()
export type WslDaemonIncarnation = z.infer<typeof wslDaemonIncarnationSchema>

const recovery = z
  .object({
    kind: z.literal('daemon'),
    distro: identity,
    relayBuildId: identity,
    endpoint,
    incarnation: wslDaemonIncarnationSchema.optional()
  })
  .strict()
  .refine((value) => value.distro === value.endpoint.distro)

export type WslDaemonRecovery = z.infer<typeof recovery>
export type PersistedWslDaemonEndpoint = z.infer<typeof endpoint>

/** Only endpoint identity is persisted; authentication remains in the guest-private token file. */
export function normalizeWslDaemonRecovery(value: unknown): WslDaemonRecovery | null {
  const parsed = recovery.safeParse(value)
  return parsed.success ? parsed.data : null
}

// Guest-owned terminals first shipped at v36; absent metadata has a fixed meaning.
export const INITIAL_WSL_DAEMON_PROTOCOL_VERSION = 36

export function sameWslDaemonEndpoint(
  left: PersistedWslDaemonEndpoint,
  right: PersistedWslDaemonEndpoint
): boolean {
  return (
    JSON.stringify({
      ...left,
      protocolVersion: left.protocolVersion ?? INITIAL_WSL_DAEMON_PROTOCOL_VERSION
    }) ===
    JSON.stringify({
      ...right,
      protocolVersion: right.protocolVersion ?? INITIAL_WSL_DAEMON_PROTOCOL_VERSION
    })
  )
}
