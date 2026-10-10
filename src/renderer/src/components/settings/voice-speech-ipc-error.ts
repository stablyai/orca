/** Returns the main-process error text without Electron's `ipcRenderer.invoke` transport prefix. */
export function describeSpeechIpcError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
}
