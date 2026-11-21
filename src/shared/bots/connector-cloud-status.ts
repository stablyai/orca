/**
 * What a host's bot list says of its link to Orca Cloud; `refused` comes with the cloud's words, and
 * `needs-sign-in` is a connector that keeps refusing this sign-in while the app stays signed in.
 */
export const CONNECTOR_CLOUD_STATUSES = [
  'signed-out',
  'needs-sign-in',
  'unreachable',
  'refused',
  'ok'
] as const

export type ConnectorCloudStatus = (typeof CONNECTOR_CLOUD_STATUSES)[number]
