import { useEffect, useState } from 'react'
import { useAppStore } from '@/store'
import { callRuntimeRpc } from '../../../runtime/rpc/calls/runtime-rpc-call'
import { getProjectCloneCheckTarget } from '../../../store/projects/project-host-routing'
import { getHostSettingOverride } from '../../../../../shared/execution-host/host-setting-overrides'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import type {
  ExistingCheckoutSuggestion,
  FindExistingCheckoutsArgs
} from '../../../../../shared/project/host-setup/existing-checkout-suggestions'
import type { RepoKind } from '../../../../../shared/repository/repo-types'

export type ExistingCheckoutSuggestionsState = {
  loading: boolean
  suggestions: ExistingCheckoutSuggestion[]
}

async function findExistingCheckoutsOnHost(
  hostId: ExecutionHostId,
  args: FindExistingCheckoutsArgs
): Promise<ExistingCheckoutSuggestion[]> {
  const target = getProjectCloneCheckTarget(hostId)
  if (!target) {
    return []
  }
  if (target.kind === 'local') {
    return window.api.projects.findExistingCheckouts(args)
  }
  const result = await callRuntimeRpc<{ suggestions: ExistingCheckoutSuggestion[] }>(
    target,
    'projectHostSetup.findExistingCheckouts',
    args,
    { timeoutMs: 20_000 }
  )
  return result.suggestions
}

/** Looks for checkouts of the project already on the host; failures and older hosts just yield none. */
export function useExistingCheckoutSuggestions(args: {
  hostId: ExecutionHostId
  projectName: string
  projectKind: RepoKind
  remoteUrl: string
}): ExistingCheckoutSuggestionsState {
  const { hostId, projectName, projectKind, remoteUrl } = args
  const hostWorktreeRoot = useAppStore((state) =>
    getHostSettingOverride(state.settings, hostId, 'defaultWorktreeLocation')
  )
  const [state, setState] = useState<ExistingCheckoutSuggestionsState>({
    loading: true,
    suggestions: []
  })

  useEffect(() => {
    let cancelled = false
    setState({ loading: true, suggestions: [] })
    findExistingCheckoutsOnHost(hostId, {
      projectName,
      kind: projectKind,
      ...(remoteUrl ? { remoteUrl } : {}),
      ...(hostWorktreeRoot ? { extraRoots: [hostWorktreeRoot] } : {})
    })
      .catch((error: unknown) => {
        console.warn('Failed to look for existing checkouts on host:', error)
        return []
      })
      .then((suggestions) => {
        if (!cancelled) {
          setState({ loading: false, suggestions })
        }
      })
    return () => {
      cancelled = true
    }
  }, [hostId, hostWorktreeRoot, projectKind, projectName, remoteUrl])

  return state
}
