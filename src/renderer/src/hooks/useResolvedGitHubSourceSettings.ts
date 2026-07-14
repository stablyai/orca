import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import type { GlobalSettings } from '../../../shared/types'
import { resolveGitHubSourceSettings } from '@/lib/github-source-runtime-context'
import { getSettingsForRepoRuntimeOwner } from '@/lib/repo-runtime-owner'
import { useAppStore } from '@/store'

// Why: every GitHub source-settings panel must start from the repo-owner host
// and apply the source override the same way (#6957/#7590); one hook keeps the
// call sites consistent by construction instead of by copy-paste.
export function useResolvedGitHubSourceSettings(
  repoId: string | null,
  sourceContext: TaskSourceContext | null | undefined
): Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> {
  const repoOwnerSettings = useAppStore(
    useShallow((s) => getSettingsForRepoRuntimeOwner(s, repoId))
  )
  return useMemo(
    () => resolveGitHubSourceSettings(repoOwnerSettings, sourceContext),
    [repoOwnerSettings, sourceContext]
  )
}
