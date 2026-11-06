/** A new workspace's held opening message as its host's prepared launch founds the chat with it:
 *  text, images and picked skills whole. Client files staged for a paired host upload to it under
 *  that launch, and only once the host awaits the message. */

import { useAppStore } from '@/store'
import type { WorktreeCreationRequest } from '@/lib/pending-worktree-creation'
import { runtimeTargetForRepoOwner } from '@/lib/repo-runtime-owner'
import { runtimeRpcTargetForAuthorityKey } from '@/runtime/runtime-client-target'
import {
  nativeChatStagedInputPaths,
  type captureNativeChatStagedInput
} from '@/components/native-chat/native-chat-draft-attachment-staging'
import type { StructuredAgentSessionAttachment } from '../../../shared/agent-session/requests/structured-agent-session-send-mutation'
import type { AgentJournalSkillRef } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'

export type HostLaunchHeldMessage = {
  text: string
  attachments: readonly StructuredAgentSessionAttachment[]
  skills?: readonly AgentJournalSkillRef[]
  /** Its client files the host must receive first, and the creation's lease on them, which the
   *  launch takes over. */
  staged?: {
    paths: readonly string[]
    lease: ReturnType<typeof captureNativeChatStagedInput>
  }
}

/** The host a creation runs on, reached as its create call reaches it. */
export function creationHostTarget(request: WorktreeCreationRequest): RuntimeClientTarget | null {
  const hostId = request.workspaceRunContext?.hostId ?? request.executionHostId
  return hostId
    ? (runtimeRpcTargetForAuthorityKey(hostId) ?? { kind: 'local' })
    : runtimeTargetForRepoOwner(useAppStore.getState(), request.repoId)
}

export function creationHeldMessage(args: {
  creationId: string
  request: WorktreeCreationRequest
  prompt: string | undefined
  attachments: StructuredAgentSessionAttachment[] | undefined
  staged: ReturnType<typeof captureNativeChatStagedInput>
  sourceScope: string
}): HostLaunchHeldMessage {
  const pending = useAppStore.getState().pendingWorktreeCreations[args.creationId]
  const sessionId = pending?.hostLaunch?.sessionId
  const skills = pending?.heldChatSkills?.length ? pending.heldChatSkills : undefined
  const input = { text: args.prompt ?? '', attachments: args.attachments ?? [] }
  // A local host reads the client's own paths; only a paired one needs them uploaded.
  const paths =
    creationHostTarget(args.request)?.kind === 'environment'
      ? nativeChatStagedInputPaths(args.sourceScope, input)
      : []
  return {
    ...input,
    ...(skills ? { skills } : {}),
    ...(sessionId && paths.length ? { staged: { paths, lease: args.staged } } : {})
  }
}
