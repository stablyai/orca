import { z } from 'zod'
import { OptionalString, requiredString } from './rpc-param-primitives'
import { OptionalExecutionHostId } from './worktree-params'

export const RepoSelector = z.object({
  repo: requiredString('Missing repo selector')
})

/** `repo.show`: `repoHostId` narrows a repo id set up on several hosts; older hosts drop it. */
export const RepoShow = RepoSelector.extend({ repoHostId: OptionalExecutionHostId })

export const SlugRepo = z.object({
  owner: requiredString('Missing owner'),
  repo: requiredString('Missing repo'),
  // Preserve Enterprise host through parsing for host-qualified gh requests.
  host: OptionalString
})
