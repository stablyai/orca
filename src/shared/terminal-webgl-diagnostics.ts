/** Register a component-owned breadcrumb sink so lib WebGL code can record diagnostics without a backward import. No-op until registration or outside the renderer. */

/** Crash-report breadcrumb name these crumbs are mirrored under. */
export const TERMINAL_WEBGL_DIAGNOSTIC_BREADCRUMB = 'terminal_webgl_diagnostic'

export type WebglDiagnosticRecorder = (
  kind: string,
  detail?: Record<string, string | number | boolean | null>
) => void

let recorder: WebglDiagnosticRecorder | null = null

export function setTerminalWebglDiagnosticRecorder(next: WebglDiagnosticRecorder | null): void {
  recorder = next
}

export function recordTerminalWebglDiagnostic(
  kind: string,
  detail?: Record<string, string | number | boolean | null>
): void {
  recorder?.(kind, detail)
}
