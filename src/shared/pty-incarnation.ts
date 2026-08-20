export type PtyIncarnationId = string

export const PTY_INCARNATION_ADDRESSED_SHUTDOWN_VERSION = 1

export function isPtyIncarnationId(value: unknown): value is PtyIncarnationId {
  return typeof value === 'string' && value.length > 0 && value.length <= 128
}
