import type { FilesystemApi } from '../../../preload/api/filesystem/filesystem-api'
import type {
  LocalLogTailChangedPayload,
  LocalLogTailReadArgs,
  LocalLogTailReadResult,
  LocalLogTailWatchArgs
} from '../../../shared/local-log-tail-types'
import { invokeNative, isTauriNativeHost, listenNative } from './tauri-native-host'

/** Native local log snapshot tailing used by the editor's live log tabs. */
export function createTauriNativeLocalLogTailApi(
  fallbackReadFile?: FilesystemApi['fs']['readFile']
): Partial<FilesystemApi['fs']> {
  if (!isTauriNativeHost()) {
    return {}
  }
  const api: Partial<FilesystemApi['fs']> = {
    readLocalLogTail: (args: LocalLogTailReadArgs): Promise<LocalLogTailReadResult> =>
      invokeNative('poc_read_local_log_tail', { args }),
    startLocalLogTail: (args: LocalLogTailWatchArgs): Promise<void> =>
      invokeNative('poc_start_local_log_tail', { args }),
    stopLocalLogTail: ({ subscriptionId }: { subscriptionId: string }): Promise<void> =>
      invokeNative('poc_stop_local_log_tail', { subscriptionId }),
    onLocalLogTailChanged: (
      callback: (payload: LocalLogTailChangedPayload) => void
    ): (() => void) => listenNative('fs:localLogTailChanged', callback)
  }
  if (fallbackReadFile) {
    api.readFile = async ({ filePath, includeLocalLogMetadata, connectionId, ...args }) =>
      includeLocalLogMetadata === true && connectionId === undefined
        ? invokeNative('poc_read_local_log_snapshot', { path: filePath })
        : fallbackReadFile({ filePath, includeLocalLogMetadata, connectionId, ...args })
  }
  return api
}
