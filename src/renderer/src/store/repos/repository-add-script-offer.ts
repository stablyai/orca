import { acceptRepositoryAddScriptPreview } from '../../../../shared/repository-add-script-route'
import type {
  RepositoryAddScriptPreview,
  RepositoryAddScriptRequest
} from '../../../../shared/repository-add-script-types'
import { offerRepositoryAddScript } from '../repository-add-script-prompt'

/** Queues the preview only when it names this request's host and the repo this call registered. */
export function offerRegistrationAddScript(
  request: RepositoryAddScriptRequest | undefined,
  repoId: string,
  preview: RepositoryAddScriptPreview | undefined
): void {
  const offered = request
    ? acceptRepositoryAddScriptPreview(request.hostId, repoId, preview)
    : undefined
  if (offered) {
    offerRepositoryAddScript(offered)
  }
}
