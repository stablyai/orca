import {
  onRuntimeEnvironmentRevisionsChanged,
  onRuntimeEnvironmentsRetired
} from '@/runtime/runtime-environment-revision'
import type { AppState } from './types'

/**
 * Identities read the runtime revision registry, which lives outside the store. Retirement fires
 * before the new revisions publish, so a retired view still resolves its old record and detaches
 * from it with its draft; a revision change re-resolves every identity.
 */
export function attachEditorBufferIdentityEvents(getState: () => AppState): () => void {
  const stopRetired = onRuntimeEnvironmentsRetired((ids) =>
    getState().detachRetiredEditorBuffers(ids)
  )
  const stopChanged = onRuntimeEnvironmentRevisionsChanged(() =>
    getState().reconcileEditorBufferIdentities()
  )
  return () => {
    stopRetired()
    stopChanged()
  }
}
