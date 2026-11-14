import { e2eConfig } from '@/app-shell/startup/e2e-config'

const PTY_CONNECT_DIAG_LIMIT = 200

export function recordPtyConnectDiagnostic(message: string): void {
  if (!e2eConfig.exposeStore) {
    return
  }
  console.log(`[pty-connect] ${message}`)
  // SAFETY: The E2E diagnostic sink is an optional property on the renderer global.
  const target = globalThis as Record<string, unknown>
  // SAFETY: This writer initializes the sink as a string array and appends only messages.
  const diag = (target.__ptyConnectDiag ??= [] as string[]) as string[]
  diag.push(message)
  if (diag.length > PTY_CONNECT_DIAG_LIMIT) {
    diag.splice(0, diag.length - PTY_CONNECT_DIAG_LIMIT)
  }
}
