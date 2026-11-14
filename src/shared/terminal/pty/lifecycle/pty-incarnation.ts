export type PtyIncarnationId = string

export function isPtyIncarnationId(value: unknown): value is PtyIncarnationId {
  return typeof value === 'string' && value.length > 0 && value.length <= 128
}
