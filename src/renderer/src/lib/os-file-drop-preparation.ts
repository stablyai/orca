import {
  createRejectedNativeFileDropPayload,
  validateNativeFileDropPaths
} from '../../../shared/native-file-drop'
import type {
  DroppedPathConsumer,
  PreparedDroppedPaths
} from '../../../shared/native-file-drop-preparation'

/** Validate OS file paths and let main temp-copy the ones that may vanish before delivery. */
export async function prepareOsFileDropPaths(
  paths: string[],
  consumer: DroppedPathConsumer
): Promise<PreparedDroppedPaths> {
  const validation = validateNativeFileDropPaths(paths)
  if (validation.status === 'rejected') {
    return { paths: [], failures: [createRejectedNativeFileDropPayload(validation)] }
  }
  try {
    return await window.api.fs.prepareDroppedPaths({ paths, consumer })
  } catch {
    return {
      paths: [],
      failures: [
        {
          target: 'rejected',
          reason: 'temp-copy-failed',
          commonReason: 'copy-failed',
          pathCount: paths.length,
          byteLength: validation.byteLength
        }
      ]
    }
  }
}
