import type { PreloadApi } from '../../../../../preload/api-types'
import { callRuntimeResult } from '../../runtime/client/web-runtime-calls'

type WorktreesApi = NonNullable<Partial<PreloadApi>['worktrees']>

export const resolveGiteaPrBaseViaRuntime: NonNullable<
  WorktreesApi['resolveGiteaPrBase']
> = async ({ repoId, prNumber, headRefName, baseRefName, isCrossRepository, wakeWslDistro }) =>
  callRuntimeResult('worktree.resolveGiteaPrBase', {
    repo: repoId,
    prNumber,
    headRefName,
    baseRefName,
    isCrossRepository,
    ...(wakeWslDistro ? { wakeWslDistro } : {})
  })
