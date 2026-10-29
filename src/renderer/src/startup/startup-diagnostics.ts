type StartupDiagnosticDetails = Record<string, unknown>

function nowMs(): number {
  return Math.round(performance.now())
}

export function logRendererStartupDiagnostic(
  event: string,
  details: StartupDiagnosticDetails = {}
): void {
  const api = window.api?.app
  if (!api?.startupDiagnostic) {
    return
  }
  void api
    .startupDiagnostic(`renderer-${event}`, {
      rendererT: nowMs(),
      ...details
    })
    .catch(() => {
      // Diagnostics are best-effort and must never perturb startup behavior.
    })
}

export async function timeRendererStartupStep<T>(
  event: string,
  operation: () => Promise<T>,
  details: StartupDiagnosticDetails = {}
): Promise<T> {
  const startedAt = performance.now()
  try {
    const result = await operation()
    logRendererStartupDiagnostic(`${event}-done`, {
      durationMs: Math.round(performance.now() - startedAt),
      ...details
    })
    return result
  } catch (error) {
    logRendererStartupDiagnostic(`${event}-failed`, {
      durationMs: Math.round(performance.now() - startedAt),
      message: error instanceof Error ? error.message : String(error),
      ...details
    })
    throw error
  }
}

export function timeRendererStartupSyncStep<T>(
  event: string,
  operation: () => T,
  details: StartupDiagnosticDetails = {}
): T {
  const startedAt = performance.now()
  try {
    const result = operation()
    logRendererStartupDiagnostic(`${event}-done`, {
      durationMs: Math.round(performance.now() - startedAt),
      ...details
    })
    return result
  } catch (error) {
    logRendererStartupDiagnostic(`${event}-failed`, {
      durationMs: Math.round(performance.now() - startedAt),
      message: error instanceof Error ? error.message : String(error),
      ...details
    })
    throw error
  }
}
