import { useMemo } from 'react'
import { useWorkerAutoClose } from '@/runtime/agent-orchestration/worker-auto-close'
import { useTranslate } from '@/i18n/use-translate'
import { PaneTopBanner } from '../../terminal-pane/appearance/pane-top-banner/PaneTopWarningBanner'
import { workerAutoCloseBannerProps } from '../../terminal-pane/worker-lifetime/worker-auto-close-banner'
import type { NativeChatStructuredViewProps } from '../native-chat-view-types'
import { structuredAgentSessionPaneKey } from '../../../../../shared/agent-session/view/structured-agent-session-projection'

/** A temporary orchestration worker chat's banner, as a terminal worker shows it, above the messages. */
export function NativeChatWorkerAutoCloseBanner({
  pane: { tabId, sessionId, target: chatTarget, isVisible }
}: {
  pane: Pick<NativeChatStructuredViewProps, 'tabId' | 'sessionId' | 'target' | 'isVisible'>
}): React.JSX.Element | null {
  const t = useTranslate()
  const environmentId = chatTarget.kind === 'local' ? null : (chatTarget.environmentId ?? null)
  const target = useMemo(
    () =>
      environmentId !== null
        ? { kind: 'environment' as const, environmentId }
        : { kind: 'local' as const },
    [environmentId]
  )
  const subject = useMemo(() => ({ sessionId }), [sessionId])
  const { state, nowMs, keepOpen } = useWorkerAutoClose(
    target,
    subject,
    structuredAgentSessionPaneKey(tabId, sessionId),
    isVisible
  )
  const banner = workerAutoCloseBannerProps(state, nowMs, keepOpen, t, environmentId)
  // In flow, so messages start below it. Not `font-sans`: chat maps that to its font, which can be monospace.
  return banner ? (
    <PaneTopBanner {...banner} className="shrink-0 font-(family-name:--font-sans)" />
  ) : null
}
