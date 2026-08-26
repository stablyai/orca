import { getAgentLaunchPlatformForRepo } from '@/lib/agent-launch-platform'
import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import { getConnectionIdFromState } from '@/lib/connection-context'
import { isNativeChatTranscriptLocalReadable } from '@/lib/native-chat-transcript-readability'
import { getRendererAppPlatform } from '@/lib/renderer-app-platform'
import { useAppStore } from '@/store'
import { repoIsRemote } from '../../../shared/agent-launch-remote'
import { resolveLocalWindowsAgentStartupShell } from '../../../shared/windows-terminal-shell'
import {
  buildDefaultAgentStartupPayload,
  resolveEmptyWorktreeDefaultAgent
} from '@/lib/default-agent-startup-payload'
import type { WorktreeStartupPayload } from '@/lib/worktree-startup-payload'

export { buildDefaultAgentStartupPayload, resolveEmptyWorktreeDefaultAgent }

export function buildEmptyWorktreeDefaultAgentStartup(
  worktreeId: string
): WorktreeStartupPayload | undefined {
  const state = useAppStore.getState()
  const settings = state.settings
  if (!settings) {
    return undefined
  }
  const connectionId = getConnectionIdFromState(state, worktreeId)
  const detectedAgentIds =
    typeof connectionId === 'string'
      ? state.remoteDetectedAgentIds[connectionId]
      : state.detectedAgentIds
  const agent = resolveEmptyWorktreeDefaultAgent({ settings, detectedAgentIds })
  if (!agent) {
    return undefined
  }

  const worktree = state.getKnownWorktreeById(worktreeId)
  const repo = worktree ? state.repos.find((entry) => entry.id === worktree.repoId) : undefined
  const isRemote = repo ? repoIsRemote(repo) : Boolean(connectionId)
  const platform = repo
    ? getAgentLaunchPlatformForRepo(
        repo,
        repo.connectionId ? undefined : getLocalProjectExecutionRuntimeContext(state, worktreeId)
      )
    : isRemote
      ? 'linux'
      : getRendererAppPlatform()
  const shell = resolveLocalWindowsAgentStartupShell({
    platform,
    isRemote,
    terminalWindowsShell: settings.terminalWindowsShell
  })

  return buildDefaultAgentStartupPayload({
    agent,
    settings,
    launchSource: 'sidebar',
    nativeChatTranscriptIsLocalReadable: isNativeChatTranscriptLocalReadable(connectionId),
    platform,
    isRemote,
    shell
  })
}
