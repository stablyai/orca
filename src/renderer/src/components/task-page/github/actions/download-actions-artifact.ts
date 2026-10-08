import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import {
  startActionsArtifactDownload,
  readActionsArtifactChunk,
  releaseActionsArtifactDownload
} from '@/store/github/actions-artifact-requests'
import type { ActionsRequestContext } from '../../../../../../shared/github/actions-types'
import type { ActionsArtifactDownloadQuery } from '../../../../../../shared/github/actions-artifact-types'
/** Save ZIP chunks to the chosen destination; always release remote bytes and cancel unfinished local writes. */
export async function downloadActionsArtifact(
  context: ActionsRequestContext,
  query: ActionsArtifactDownloadQuery,
  name: string,
  live: () => boolean,
  progress: (percent: number) => void
): Promise<string | null> {
  const local = await window.api.fs.startDownloadedFile({ suggestedName: `${name}.zip` })
  if (local.canceled) {
    return null
  }
  let remoteId: string | null = null
  let finished = false
  try {
    if (!live()) {
      throw new Error('Artifact download canceled')
    }
    const remote = await startActionsArtifactDownload(useAppStore.getState(), context, query)
    remoteId = remote.transferId
    let offset = 0
    while (offset < remote.sizeBytes) {
      if (!live()) {
        throw new Error('Artifact download canceled')
      }
      const chunk = await readActionsArtifactChunk(useAppStore.getState(), context, {
        transferId: remoteId,
        offset
      })
      if (chunk.nextOffset <= offset || chunk.nextOffset > remote.sizeBytes) {
        throw new Error(
          translate('actions.artifacts.invalidChunk', 'Invalid artifact download chunk')
        )
      }
      await window.api.fs.appendDownloadedFileChunk({
        transferId: local.transferId,
        contentBase64: chunk.contentBase64
      })
      offset = chunk.nextOffset
      progress(Math.round((offset / remote.sizeBytes) * 100))
    }
    if (!live()) {
      throw new Error('Artifact download canceled')
    }
    const result = await window.api.fs.finishDownloadedFile({ transferId: local.transferId })
    finished = true
    return result.destinationPath
  } finally {
    if (remoteId) {
      await releaseActionsArtifactDownload(useAppStore.getState(), context, {
        transferId: remoteId
      }).catch(() => {})
    }
    if (!finished) {
      await window.api.fs.cancelDownloadedFile({ transferId: local.transferId }).catch(() => {})
    }
  }
}
