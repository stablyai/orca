import { useMemo } from 'react'
import {
  useWorkerAutoClose,
  workerAutoCloseStripText,
  workerKeepOpenLabel
} from '@/runtime/agent-orchestration/worker-auto-close'
import { NativeChatWorkerLifetimeStrip } from './NativeChatWorkerLifetimeStrip'
import type { NativeChatStructuredComposerTransport } from '../composer/submit/native-chat-structured-composer-transport'
import { useTranslate } from '@/i18n/use-translate'
import { chatPaneKey } from '../../../../../shared/agent-session/view/structured-agent-session-projection'

/** A temporary orchestration worker chat says when it closes, with Keep open, on its composer. */
export function NativeChatStructuredWorkerLifetimeStrip({
  transport: { sessionId, runtimeEnvironmentId },
  isVisible
}: {
  transport: Pick<NativeChatStructuredComposerTransport, 'sessionId' | 'runtimeEnvironmentId'>
  isVisible: boolean
}): React.JSX.Element | null {
  const t = useTranslate()
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
    chatPaneKey(sessionId),
    isVisible
  )
  const text = workerAutoCloseStripText(state, nowMs, t)
  return text ? (
    <NativeChatWorkerLifetimeStrip
      text={text}
      keepOpenLabel={workerKeepOpenLabel(t)}
      onKeepOpen={keepOpen}
    />
  ) : null
}
