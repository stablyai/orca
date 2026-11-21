import { compactIpcErrorMessage } from '@/runtime/errors/ipc-error'
import type { Translate } from '@/i18n/use-translate'

// Only a remote host's refusal: local spawn errors keep the wrapper their copy matches against.
const HOST_REFUSAL_IPC_LINE = /Error invoking remote method 'runtimeEnvironments:/

/** A host refusal main threw reaches a pane wrapped in Electron's "Error invoking remote method…". */
export function unwrapHostRefusalIpcLines(error: string, t?: Translate): string {
  return error
    .split('\n')
    .map((line) =>
      HOST_REFUSAL_IPC_LINE.test(line) ? (compactIpcErrorMessage(line, t) ?? line) : line
    )
    .join('\n')
}
