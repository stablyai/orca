export function decodeAntigravityStepIndex(value: unknown): number | undefined {
  const index = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value
  return typeof index === 'number' && Number.isSafeInteger(index) && index >= 0 ? index : undefined
}
