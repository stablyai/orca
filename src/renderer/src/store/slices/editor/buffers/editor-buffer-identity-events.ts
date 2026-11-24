import {
  onRuntimeEnvironmentRevisionsChanged,
  onRuntimeEnvironmentsRetired
} from '@/runtime/rpc/environment-revisions/runtime-environment-revision'
import type { AppState } from '../../../types'

/** Retire before publishing external runtime revisions so views detach from old records with drafts; revision changes then resolve every identity. */
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
