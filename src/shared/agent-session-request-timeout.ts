// A provider request Orca stopped waiting for, carried on a start failure so a reader can say
// which step stalled and for how long instead of a bare "couldn't start".

export type AgentSessionRequestTimeout = {
  /** The provider's protocol method, e.g. `thread/start`; never its params. */
  method: string
  timeoutMs: number
}

// A protocol method name, not free text: the words show it as it is.
const METHOD_NAME = /^[A-Za-z][\w./-]{0,63}$/

/** A timeout as a reader meets it; undefined unless both fields are ones this build can show. */
export function readAgentSessionRequestTimeout(
  value: unknown
): AgentSessionRequestTimeout | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined
  }
  const record: Record<string, unknown> = { ...value }
  const { method, timeoutMs } = record
  return typeof method === 'string' &&
    METHOD_NAME.test(method) &&
    typeof timeoutMs === 'number' &&
    Number.isInteger(timeoutMs) &&
    timeoutMs > 0
    ? { method, timeoutMs }
    : undefined
}

/** Whole seconds, at least one, as the words say a deadline. */
export function requestTimeoutSeconds({ timeoutMs }: AgentSessionRequestTimeout): string {
  return String(Math.max(1, Math.round(timeoutMs / 1000)))
}
