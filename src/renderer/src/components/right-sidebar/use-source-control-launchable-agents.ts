import { useCallback, useState } from 'react'
import { useAppStore } from '@/store'
import {
  ensureDetectedAgentsForWorktree,
  readAgentInventoryForWorktree,
  readAgentInventoryForTarget
} from '@/lib/agent-detection-target-inventory'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { sourceControlLaunchWorkspace } from './source-control-launch-agent-args-applicability'
import { acquireAgentLaunchChoices, useChatProgramFacts } from '@/lib/host-chat-program-acquisition'
import { agentsOfferedForLaunch } from '@/lib/host-chat-program'

type LaunchTarget = Parameters<typeof sourceControlLaunchWorkspace>[0]

export function useSourceControlLaunchableAgents(args: {
  target: LaunchTarget
  connectionId: string | null | undefined
  connectionUnavailable: boolean
  active: boolean
}) {
  const { target, connectionId, connectionUnavailable, active } = args
  const { worktreeId, repoId, executionHostId } = target
  const [detecting, setDetecting] = useState(false)
  const workspace = sourceControlLaunchWorkspace(target)
  useChatProgramFacts(workspace, active && !connectionUnavailable)
  // Source Control renders with the dialog closed; only an open dialog lists agents.
  const detected = useAppStore((state) =>
    !active
      ? null
      : worktreeId
        ? readAgentInventoryForWorktree(state, worktreeId).ids
        : readAgentInventoryForTarget(
            state,
            typeof connectionId === 'string' ? { kind: 'ssh', connectionId } : { kind: 'local' }
          ).ids
  )
  const refreshAgents = useCallback(async () => {
    if (connectionUnavailable) {
      return { detected: [], launchable: [] }
    }
    setDetecting(true)
    try {
      const choices = await acquireAgentLaunchChoices(
        sourceControlLaunchWorkspace({ worktreeId, repoId, executionHostId }),
        () => {
          const state = useAppStore.getState()
          return worktreeId
            ? ensureDetectedAgentsForWorktree(state, worktreeId)
            : typeof connectionId === 'string'
              ? state.ensureRemoteDetectedAgents(connectionId)
              : state.ensureDetectedAgents()
        }
      )
      return { detected: [...(choices.detected ?? [])], launchable: choices.offered }
    } finally {
      setDetecting(false)
    }
  }, [connectionId, connectionUnavailable, executionHostId, repoId, worktreeId])
  const refreshLaunchableAgents = useCallback(
    async (): Promise<TuiAgent[]> => (await refreshAgents()).launchable,
    [refreshAgents]
  )
  return {
    detecting,
    refreshAgents,
    refreshLaunchableAgents,
    launchableAgents: active
      ? agentsOfferedForLaunch(useAppStore.getState(), workspace, detected)
      : []
  }
}
