/** A parsed JSON object or zod metadata record, read by key while walking unvalidated input. */
export function isPluginJsonObject(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null
}
