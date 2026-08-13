import type { SessionOptionValue } from './native-chat-session-options'

/** Omits the key entirely when no picker options applied, keeping plans byte-stable. */
export function appliedSessionOptionProps(values: Record<string, SessionOptionValue>): {
  sessionOptions?: Record<string, SessionOptionValue>
} {
  return Object.keys(values).length > 0 ? { sessionOptions: { ...values } } : {}
}
