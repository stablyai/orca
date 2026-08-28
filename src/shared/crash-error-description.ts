import {
  MAX_CRASH_REPORT_STACK_CHARS,
  sanitizeCrashReportString,
  type CrashReportBreadcrumbData
} from './crash-reporting'

export type CrashErrorDescription = CrashReportBreadcrumbData

export function describeCrashError(
  error: unknown,
  componentStack?: string | null
): CrashErrorDescription {
  let candidate: Error | null = null
  try {
    candidate = error instanceof Error ? error : null
  } catch {
    // A revoked proxy can throw while checking its prototype.
  }

  const message = safeString(
    readErrorProperty(candidate, 'message') ?? error,
    '[unprintable thrown value]'
  )
  const rawName = readErrorProperty(candidate, 'name')
  const name = rawName == null ? 'NonErrorThrown' : safeString(rawName, 'NonErrorThrown')
  const rawStack = readErrorProperty(candidate, 'stack')
  const stack = rawStack == null ? '' : safeString(rawStack, '')
  const sanitizedMessage = sanitizeCrashReportString(message)

  return {
    errorName: sanitizeCrashReportString(name || 'NonErrorThrown', 80),
    errorMessage: sanitizedMessage,
    errorFingerprint: fingerprint(sanitizedMessage),
    ...(stack
      ? { errorStack: sanitizeCrashReportString(stack, MAX_CRASH_REPORT_STACK_CHARS) }
      : {}),
    ...(typeof componentStack === 'string' && componentStack.trim()
      ? {
          componentStack: sanitizeCrashReportString(
            componentStack.trim(),
            MAX_CRASH_REPORT_STACK_CHARS
          )
        }
      : {})
  }
}

function readErrorProperty(error: Error | null, key: 'message' | 'name' | 'stack'): unknown {
  try {
    return error?.[key]
  } catch {
    return undefined
  }
}

function safeString(value: unknown, fallback: string): string {
  if (typeof value === 'string') {
    return value
  }
  try {
    return String(value)
  } catch {
    return fallback
  }
}

function fingerprint(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}
