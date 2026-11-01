import { extractIpcErrorMessage } from '@/lib/ipc-error'

/** Drops Electron's "Error invoking remote method" wrapper; an empty message stays empty (still a failed read). */
export function describeFileExplorerReadError(error: unknown): string {
  return extractIpcErrorMessage(error, error instanceof Error ? error.message : String(error))
}
