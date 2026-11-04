/** A plain JSON object, narrowed without a cast; arrays and null are not records. */
export function isWorkflowJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
