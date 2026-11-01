import { useMemo } from 'react'
import {
  useWorkerAutoClose,
  workerAutoCloseStripText,
  workerKeepOpenLabel
} from '@/lib/worker-auto-close'
import { NativeChatWorkerLifetimeStrip } from './NativeChatWorkerLifetimeStrip'
import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'
import { structuredAgentSessionPaneKey } from '../../../../shared/structured-agent-session-projection'

/** A temporary orchestration worker chat says when it closes, with Keep open, on its composer. */
export function NativeChatStructuredWorkerLifetimeStrip({
  tabId,
  transport: { sessionId, runtimeEnvironmentId },
  isVisible
}: {
  tabId: string
  transport: Pick<NativeChatStructuredComposerTransport, 'sessionId' | 'runtimeEnvironmentId'>
  isVisible: boolean
}): React.JSX.Element | null {
  const target = useMemo(
    () =>
      runtimeEnvironmentId !== null
        ? { kind: 'environment' as const, environmentId: runtimeEnvironmentId }
        : { kind: 'local' as const },
    [runtimeEnvironmentId]
  )
  const subject = useMemo(() => ({ sessionId }), [sessionId])
  const { state, nowMs, keepOpen } = useWorkerAutoClose(
    target,
    subject,
    structuredAgentSessionPaneKey(tabId, sessionId),
    isVisible
  )
  const text = workerAutoCloseStripText(state, nowMs)
  return text ? (
    <NativeChatWorkerLifetimeStrip
      text={text}
      keepOpenLabel={workerKeepOpenLabel()}
      onKeepOpen={keepOpen}
    />
  ) : null
}
