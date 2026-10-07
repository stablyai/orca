/** Longest name a runtime publishes for itself; local writers truncate past it, the RPC contract rejects. */
export const MACHINE_NAME_MAX_LENGTH = 255

/** Stored form of a machine name. Anything that is not a non-blank string means "use the detected name". */
export function normalizeMachineName(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, MACHINE_NAME_MAX_LENGTH) : ''
}
