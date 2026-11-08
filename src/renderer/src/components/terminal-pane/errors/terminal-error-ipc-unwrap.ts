import { compactIpcErrorMessage } from '@/lib/ipc-error'

// Only a remote host's refusal: local spawn errors keep the wrapper their copy matches against.
const HOST_REFUSAL_IPC_LINE = /Error invoking remote method 'runtimeEnvironments:/

/** A host refusal main threw reaches a pane wrapped in Electron's "Error invoking remote method…". */
export function unwrapHostRefusalIpcLines(error: string): string {
  return error
    .split('\n')
    .map((line) =>
      HOST_REFUSAL_IPC_LINE.test(line) ? (compactIpcErrorMessage(line) ?? line) : line
    )
    .join('\n')
}
