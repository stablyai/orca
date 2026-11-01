import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import { agentLaunchPanePrompt } from '@/lib/agent-launch-pane-prompt'
import { createPortal } from 'react-dom'
import type { AgentLaunchPaneOutcome } from '../../../../shared/agent-launch-pane-verdict'
import { agentLaunchPaneNoticeText } from './agent-launch-pane-notice-text'

/** Show a non-dismissible session state when a laid-out pane’s agent is not running. */
export function AgentLaunchPaneNotice({
  refusal,
  agentId,
  tabId
}: {
  refusal: AgentLaunchPaneOutcome
  agentId?: string | null
  tabId: string
}): React.JSX.Element {
  const prompt = agentLaunchPanePrompt(tabId)
  return (
    <div
      data-agent-launch-pane-notice={refusal.kind}
      className="pointer-events-auto absolute inset-x-3 bottom-3 z-50 flex items-start justify-between gap-3 rounded-md border border-border bg-popover px-3.5 py-2.5 text-xs text-popover-foreground"
    >
      <span className="min-w-0">{agentLaunchPaneNoticeText(refusal, agentId)}</span>
      {prompt ? (
        <Button
          variant="outline"
          size="xs"
          onClick={() => void window.api.ui.writeClipboardText(prompt)}
        >
          {translate(
            'auto.components.terminal.pane.AgentLaunchPaneNotice.copyPrompt',
            'Copy prompt'
          )}
        </Button>
      ) : null}
    </div>
  )
}

/** The notice in the active pane, when that pane's error is a launch's. */
export function AgentLaunchPaneNoticePortal({
  refusal,
  agentId,
  isActive,
  pane,
  tabId
}: {
  refusal: AgentLaunchPaneOutcome | null
  agentId?: string | null
  isActive: boolean
  pane: { id: number; container: HTMLElement } | null | undefined
  tabId: string
}): React.JSX.Element | null {
  if (!refusal || !isActive || !pane) {
    return null
  }
  return createPortal(
    <AgentLaunchPaneNotice refusal={refusal} agentId={agentId} tabId={tabId} />,
    pane.container,
    `agent-launch-pane-notice-${pane.id}`
  )
}
