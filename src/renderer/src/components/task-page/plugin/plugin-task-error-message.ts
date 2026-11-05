/** Strips Electron's IPC rejection prefix so the plugin's own message shows. */
export function pluginTaskErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
}
