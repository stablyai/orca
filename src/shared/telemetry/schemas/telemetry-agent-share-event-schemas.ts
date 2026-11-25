import { z } from 'zod'

// Where sharing an agent failed, in closed enums only: no share, account or device ids, no names,
// emails, URLs, error text or message content.

/** An Orca Cloud answer that wasn't the one asked for. */
export const AGENT_SHARE_CLOUD_REASONS = [
  'unknown_share',
  'host_not_sharing',
  'invalid_request',
  'rate_limited',
  'signed_out',
  'http_4xx',
  'http_5xx',
  // No readable answer: network loss, a timeout, or a body that is not the contract.
  'network'
] as const

const stage = <S extends string, R extends readonly [string, ...string[]]>(name: S, reasons: R) =>
  z.object({ stage: z.literal(name), reason: z.enum(reasons) }).strict()

export const agentShareFailedSchema = z.discriminatedUnion('stage', [
  // Teammate: accepting a share.
  stage('accept', AGENT_SHARE_CLOUD_REASONS),
  // Teammate: Orca Cloud says the host is online, but its link didn't come up.
  stage('host_unreachable', ['pairing_refused', 'not_reached']),
  // Teammate: the shares list got no answer several reads running.
  stage('host_status_unknown', ['network', 'http_5xx']),
  // Teammate: Orca Cloud didn't hold a message for a host that is away.
  stage('held_send', [...AGENT_SHARE_CLOUD_REASONS, 'too_large', 'other']),
  // Teammate: a held message the host then refused.
  stage('held_not_sent', ['refused']),
  // Owner: the share guard refused a teammate's call.
  stage('admission_refused', ['bot_not_found', 'session_not_found', 'method_not_found']),
  // Owner: a held message delivered through Orca Cloud was refused.
  stage('held_delivery_refused', [
    'host_key_unavailable',
    'bad_signature',
    'unknown_share',
    'unknown_device',
    'session_not_found',
    'other'
  ]),
  // Either: this desktop refused its own phone page bundle, so no phone page loads.
  stage('phone_bundle_refused', ['invalid_json', 'manifest_contract'])
])

export type AgentShareFailure = z.infer<typeof agentShareFailedSchema>
