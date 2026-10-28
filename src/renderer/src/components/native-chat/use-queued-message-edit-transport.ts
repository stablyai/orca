import { useMemo } from 'react'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import {
  useStructuredAgentSessionHostEditsQueuedMessages,
  useStructuredAgentSessionHostEditsQueuedImages,
  useStructuredAgentSessionHostEditsQueuedSkills,
  useStructuredAgentSessionHostReordersQueuedMessages
} from '@/runtime/structured-agent-session-host-capability'
import type { StructuredAgentSessionWrite } from './use-structured-agent-session-mutate'

export function useQueuedMessageEditTransport(
  target: RuntimeClientTarget,
  sessionId: string,
  write: StructuredAgentSessionWrite
) {
  const capable = useStructuredAgentSessionHostEditsQueuedMessages(target)
  const imagesCapable = useStructuredAgentSessionHostEditsQueuedImages(target)
  const skillsCapable = useStructuredAgentSessionHostEditsQueuedSkills(target)
  const reorderCapable = useStructuredAgentSessionHostReordersQueuedMessages(target)
  return useMemo(
    () => ({ target, sessionId, capable, imagesCapable, skillsCapable, reorderCapable, write }),
    [target, sessionId, capable, imagesCapable, skillsCapable, reorderCapable, write]
  )
}
