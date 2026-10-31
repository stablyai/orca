import type { AppState } from '../types'
import type { ActionsRequestContext, ActionsPage } from '../../../../shared/github/actions-types'
import type {
  ActionsArtifact,
  ActionsArtifactsQuery,
  ActionsArtifactDownloadQuery,
  ActionsArtifactTransferQuery,
  ActionsArtifactTransfer,
  ActionsArtifactChunk
} from '../../../../shared/github/actions-artifact-types'
import { requestActions } from './actions-requests'
/** Route artifact metadata reads to the registered execution owner without a client-host fallback. */
export function fetchActionsArtifacts(
  state: AppState,
  context: ActionsRequestContext,
  args: ActionsArtifactsQuery
) {
  return requestActions<ActionsPage<ActionsArtifact>>(
    state,
    context,
    'github.actionsArtifacts',
    args,
    () => window.api.gh.actionsArtifacts({ ...context, ...args })
  )
}
/** Route archive acquisition to its registered execution owner with the download-specific remote deadline. */
export function startActionsArtifactDownload(
  state: AppState,
  context: ActionsRequestContext,
  args: ActionsArtifactDownloadQuery
) {
  return requestActions<ActionsArtifactTransfer>(
    state,
    context,
    'github.startActionsArtifactDownload',
    args,
    () => window.api.gh.startActionsArtifactDownload({ ...context, ...args })
  )
}
/** Route chunk reads with the same repository/account context that owns archive acquisition. */
export function readActionsArtifactChunk(
  state: AppState,
  context: ActionsRequestContext,
  args: ActionsArtifactTransferQuery
) {
  return requestActions<ActionsArtifactChunk>(
    state,
    context,
    'github.readActionsArtifactChunk',
    args,
    () => window.api.gh.readActionsArtifactChunk({ ...context, ...args })
  )
}
/** Release remote archive storage through its owning route rather than the currently focused host. */
export function releaseActionsArtifactDownload(
  state: AppState,
  context: ActionsRequestContext,
  args: ActionsArtifactTransferQuery
) {
  return requestActions<void>(state, context, 'github.releaseActionsArtifactDownload', args, () =>
    window.api.gh.releaseActionsArtifactDownload({ ...context, ...args })
  )
}
