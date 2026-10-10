import { useSyncExternalStore } from 'react'
import { useAppStore } from '@/store'
import { useCodexMaintenance } from '@/hooks/useCodexMaintenance'
import { resolveAgentSessionLaunchRoute } from '@/lib/agent-session-launch-plan'
import { runtimeTargetForExecutionHostId } from '@/runtime/runtime-client-target'
import {
  readLocalRuntimeCapabilitiesOrUnknown,
  subscribeLocalRuntimeCapabilitiesKnown
} from '@/runtime/local-runtime-capabilities'
import type { NewWorkspaceComposerCardProps } from './new-workspace-composer-card-props'

export function useNewWorkspaceCodexMaintenance(props: NewWorkspaceComposerCardProps) {
  const capabilities = useSyncExternalStore(
    subscribeLocalRuntimeCapabilitiesKnown,
    readLocalRuntimeCapabilitiesOrUnknown,
    readLocalRuntimeCapabilitiesOrUnknown
  )
  const structured = useAppStore((state) => {
    // Re-evaluate the same launch route when the local host answers its capability probe.
    void capabilities
    return (
      props.quickAgent === 'codex' &&
      resolveAgentSessionLaunchRoute(state, {
        agent: 'codex',
        workspace: {
          kind: props.selectedRepoIsGit ? 'git-worktree' : 'folder',
          repoId: props.repoId,
          ...(props.selectedRepoExecutionHostId
            ? { executionHostId: props.selectedRepoExecutionHostId }
            : {})
        }
      }) === 'structured-native-chat'
    )
  })
  // Structured chat runs only on this computer or a paired runtime, never over SSH.
  const target = !structured
    ? null
    : props.selectedRepoExecutionHostId
      ? runtimeTargetForExecutionHostId(props.selectedRepoExecutionHostId)
      : { kind: 'local' as const }
  return useCodexMaintenance(
    target
      ? { ...target, ...(props.selectedRepoPath ? { cwd: props.selectedRepoPath } : {}) }
      : null
  )
}
