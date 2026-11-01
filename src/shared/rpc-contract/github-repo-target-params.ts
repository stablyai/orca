import { z } from 'zod'
import { OptionalBoolean, OptionalString, requiredString } from './rpc-param-primitives'
import { OptionalExecutionHostId } from './worktree-params'

export const RepoSelector = z.object({
  repo: requiredString('Missing repo selector')
})

/** `repo.show`: `repoHostId` narrows a repo id set up on several hosts; older hosts drop it. */
export const RepoShow = RepoSelector.extend({ repoHostId: OptionalExecutionHostId })

/** `repo.issueCommandRead`: `wakeWslDistro` marks a launch, which may start a stopped WSL distro; older hosts drop it. */
export const RepoIssueCommandRead = RepoSelector.extend({ wakeWslDistro: OptionalBoolean })

export const SlugRepo = z.object({
  owner: requiredString('Missing owner'),
  repo: requiredString('Missing repo'),
  // Preserve Enterprise host through parsing for host-qualified gh requests.
  host: OptionalString
})
