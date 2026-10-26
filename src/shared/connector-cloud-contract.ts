// Mirror of cloud/packages/connector-contract/src for the machine side of the Orca Cloud connector.
import { z } from 'zod'

export const CONNECTOR_CONTRACT_VERSION = 1

export const CONNECTOR_HOST_PROOF_TRANSCRIPT_DOMAIN = 'orca-connector-host-proof/v1'
export const CONNECTOR_HOST_CHALLENGE_PLAINTEXT_DOMAIN = 'orca-connector-host-challenge/v1'

// Every route is POST except hello (PUT).
export const CONNECTOR_PATHS = {
  signInStart: '/v1/host/auth/start',
  signInPoll: '/v1/host/auth/poll',
  signOut: '/v1/host/auth/unbind',
  hostChallenge: '/v1/host/challenge',
  hostSession: '/v1/host/session',
  hello: '/v1/connector/hello',
  poll: '/v1/connector/poll',
  acks: '/v1/connector/acks',
  events: '/v1/connector/events',
  replies: '/v1/connector/replies'
} as const

export const CONNECTOR_FEATURES = ['answer', 'cancel', 'reply'] as const

export const CONNECTOR_CLIENT_LIMITS = {
  pollTimeoutMs: 70_000,
  minDeadlineLeftMs: 10_000,
  maxLastAssistantMessageBytes: 8 * 1024
} as const

// Machine-side readers: they keep what this Orca uses and ignore fields a newer cloud adds.
export const ConnectorErrorResponse = z.object({ error: z.string().min(1) })

export const ConnectorSignInStartResponse = z.object({
  deviceCode: z.string().min(1),
  userCode: z.string().min(1),
  verificationUri: z.url(),
  expiresAt: z.number().int().positive(),
  interval: z.number().int().positive()
})

export const ConnectorSignInPollResponse = z.discriminatedUnion('status', [
  z.object({
    status: z.enum(['pending', 'slow_down', 'denied', 'expired']),
    interval: z.number().int().positive()
  }),
  z.object({
    status: z.literal('authorized'),
    interval: z.number().int().positive(),
    hostId: z.string().min(1),
    account: z.object({ email: z.string().min(1) })
  })
])

export const ConnectorHostChallengeResponse = z.object({
  challengeId: z.string().min(1).max(512),
  gatewayEphemeralPublicKeyB64: z.string().min(1).max(128),
  nonceB64: z.string().min(1).max(128),
  ciphertextB64: z
    .string()
    .min(1)
    .max(8 * 1024),
  expiresAt: z.number().int().positive()
})

export const ConnectorHostSessionResponse = z.object({
  sessionToken: z.string().min(1).max(1024),
  expiresAt: z.number().int().positive(),
  hostId: z.string().min(1)
})
