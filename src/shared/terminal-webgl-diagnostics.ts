/**
 * Lib-safe sink for WebGL renderer breadcrumbs (context loss/restore, atlas
 * resets). The renderer breadcrumb ring lives in the components layer
 * (terminal-freeze-breadcrumbs.ts), which may import from lib/pane-manager but
 * not the reverse. This indirection lets lib-layer WebGL code record a crumb
 * without a backward import: components registers the recorder at startup;
 * until then (and in non-renderer contexts) recording is a silent no-op.
 */

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
