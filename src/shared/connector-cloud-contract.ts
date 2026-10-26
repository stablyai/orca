// Mirror of cloud/packages/connector-contract/src for the machine side of the Orca Cloud connector.

export const CONNECTOR_CONTRACT_VERSION = 1

// Every route is POST except hello (PUT), and takes `Authorization: Bearer <connector token>`.
export const CONNECTOR_PATHS = {
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
