import { z } from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'
import { normalizeGhAccountBinding } from '../../github/accounts/account-binding'
import { OptionalBoolean, OptionalString, requiredString } from '../rpc-param-primitives'
import { OptionalExecutionHostId } from '../workspaces/worktree-params'

export const RepoSelector = lazyZodSchema(() =>
  z.object({
    repo: requiredString('Missing repo selector')
  })
)

/** `repo.show`: `repoHostId` narrows a repo id set up on several hosts; older hosts drop it. */
export const RepoShow = lazyZodSchema(() =>
  RepoSelector.extend({ repoHostId: OptionalExecutionHostId })
)

/** `repo.issueCommandRead`: `wakeWslDistro` marks a launch, which may start a stopped WSL distro; older hosts drop it. */
export const RepoIssueCommandRead = lazyZodSchema(() =>
  RepoSelector.extend({ wakeWslDistro: OptionalBoolean })
)

export const SlugRepo = lazyZodSchema(() =>
  z.object({
    owner: requiredString('Missing owner'),
    repo: requiredString('Missing repo'),
    // Preserve Enterprise host through parsing for host-qualified gh requests.
    host: OptionalString
  })
)

export const RepoWithGitHubTarget = lazyZodSchema(() =>
  RepoSelector.extend({ ownerRepo: SlugRepo.optional() })
)

export const OptionalGhAccountExpectation = lazyZodSchema(() =>
  z
    .unknown()
    .transform((value, ctx) => {
      if (value === undefined || value === null) {
        return value
      }
      const binding = normalizeGhAccountBinding(value)
      if (!binding) {
        ctx.addIssue({ code: 'custom', message: 'Invalid GitHub account expectation' })
        return z.NEVER
      }
      return binding
    })
    .optional()
)

export const RepoWithGitHubAccountExpectation = lazyZodSchema(() =>
  RepoWithGitHubTarget.extend({
    expectedGhAccount: OptionalGhAccountExpectation
  })
)
