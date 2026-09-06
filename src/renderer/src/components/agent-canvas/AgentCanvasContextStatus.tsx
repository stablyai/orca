import { useContext } from 'react'
import { translate } from '@/i18n/i18n'
import { CanvasContextStatus } from './use-canvas-agent-context'

export function AgentCanvasContextStatus({ nodeId }: { nodeId: string }) {
  const context = useContext(CanvasContextStatus)
  const status = context.nodes[nodeId]
  const label =
    context.error ??
    (status?.state === 'returned'
      ? translate('agentCanvas.contextReturned', 'Context returned to agent hook')
      : status?.state === 'ready'
        ? status.provider === 'cursor'
          ? translate('agentCanvas.contextNextTool', 'Context ready · next tool result')
          : translate('agentCanvas.contextNextPrompt', 'Context ready · next prompt')
        : status?.state === 'unsupported'
          ? translate(
              'agentCanvas.contextUnsupported',
              'Automatic context unavailable on this host'
            )
          : status?.state === 'session-changed'
            ? translate('agentCanvas.contextSessionChanged', 'Session changed · reconnect the note')
            : status?.state === 'unverifiable'
              ? translate('agentCanvas.contextUnverifiable', 'Context delivery is unverifiable')
              : translate('agentCanvas.contextWaiting', 'Waiting for the agent hook'))
  return <span role="status">{label}</span>
}
