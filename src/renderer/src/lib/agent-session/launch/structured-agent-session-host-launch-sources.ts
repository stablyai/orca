/** The client files a held host launch's opening still owes its host, held under one staging lease
 *  from the creation (or its Edit, or a reload) until no operation needs them: the first turn was
 *  handed over in host-readable form, the host acknowledged the opening, the composer durably took
 *  it back, it was replaced, or the launch was closed. Nothing else releases them. */

import type { StructuredAgentSessionFirstMessage } from '../../../../../shared/agent-session/structured-agent-session-create'
import { structuredAgentSessionSendBody } from '../../../../../shared/agent-session/requests/structured-agent-session-send-mutation'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'
import type { captureNativeChatStagedInput } from '@/components/native-chat/native-chat-draft-attachment-staging'
import { restoreNativeChatStagedInput } from '@/components/native-chat/native-chat-draft-attachment-staging'
import { structuredAgentSessionDraftScopeKey } from '@/components/native-chat/native-chat-composer-draft-store'
import type { StructuredAgentSessionLaunchIntent } from '../../launch-structured-agent-session'

type Body = StructuredAgentSessionFirstMessage['body']
type StagedLease = ReturnType<typeof captureNativeChatStagedInput>

export type HostLaunchSources = {
  /** Uploads the current opening's client files under the launch; answers its host-readable body. */
  prepare: (opening: Body, launchOperationId: string, target: RuntimeClientTarget) => Promise<Body>
  /** Hands the files to `scope`'s draft, which owns them from then on. */
  transfer?: (scope: string) => void
  release: () => void
}

/** The opening as composer input: its text, images by path, and skills. */
export function hostLaunchOpeningInput(body: Body) {
  return {
    text: body.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n'),
    attachments: body.blocks.flatMap((block) =>
      block.type === 'image-ref' && block.path ? [{ path: block.path, previewUri: '' }] : []
    ),
    ...(body.skills ? { skills: body.skills } : {})
  }
}

/** The lease's files, prepared from whatever the opening says now, never a captured copy of it. */
export function leasedHostLaunchSources(lease: StagedLease, sessionId: string): HostLaunchSources {
  return {
    prepare: async (opening, launchOperationId, target) => {
      const prepared = await lease.prepare(hostLaunchOpeningInput(opening), {
        sessionId,
        runtimeEnvironmentId: target.kind === 'environment' ? target.environmentId : null,
        launchOperationId
      })
      return structuredAgentSessionSendBody(prepared.text, prepared.attachments, prepared.skills)
    },
    transfer: (scope) => lease.transfer(scope),
    release: () => lease.release()
  }
}

/** A reloaded launch's files, held again only by the paths its record listed. */
export function restoredHostLaunchSources(
  sessionId: string,
  staged: readonly string[],
  opening: Body
): HostLaunchSources {
  // Held in the chat's own draft scope, where its draft keeps them if they come back to it.
  const lease = restoreNativeChatStagedInput(
    structuredAgentSessionDraftScopeKey(sessionId),
    staged,
    hostLaunchOpeningInput(opening)
  )
  return leasedHostLaunchSources(lease, sessionId)
}

/** Ends the launch's hold on its files; a later preparation of the same launch holds them anew
 *  only after a reload. */
export function retireHostLaunchSources(intent: StructuredAgentSessionLaunchIntent): void {
  const sources = intent.hostLaunch?.sources
  if (intent.hostLaunch && sources) {
    const { sources: _retired, ...rest } = intent.hostLaunch
    intent.hostLaunch = rest
    sources.release()
  }
}
