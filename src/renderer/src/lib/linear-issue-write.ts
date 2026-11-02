import { useAppStore } from '@/store'
import type { LinearIssue } from '../../../shared/linear/issue-types'
import type { RuntimeLinearSettings } from '@/runtime/runtime-linear-client'
import { getLinearSourceScope } from '@/store/slices/linear/linear-slice-scope'
import {
  runLinearIssueWrite,
  knownLinearOrganization
} from '@/store/slices/linear/linear-issue-publication'

export function writeLinearIssue<T extends { ok: boolean }>(
  issue: LinearIssue,
  patch: Partial<LinearIssue>,
  source: RuntimeLinearSettings,
  mutate: () => Promise<T>
): Promise<T> {
  const scope = getLinearSourceScope(source)
  const state = useAppStore.getState()
  const organizationId =
    state.linearStatusContextKey === scope.runtimeContextKey ||
    (!scope.explicitSource && !state.linearStatusContextKey)
      ? knownLinearOrganization(
          state.linearStatus.workspaces?.find((workspace) => workspace.id === issue.workspaceId)
        )
      : undefined
  return runLinearIssueWrite({
    scope,
    issue,
    patch,
    mutate,
    organizationId,
    publish: (delta) => {
      if (scope.isCurrentRuntime()) {
        useAppStore.getState().patchLinearIssue(issue.id, delta, { scope })
      }
    }
  })
}
