import { useContext, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter
} from '@/components/ui/dialog'
import { translate } from '@/i18n/i18n'
import { CanvasContextStatus } from './use-canvas-agent-context'

export function AgentCanvasContextStatus({
  nodeId,
  onAdoptSession,
  onlySessionChanged = false
}: {
  nodeId: string
  onAdoptSession?: (id: string) => void
  onlySessionChanged?: boolean
}) {
  const context = useContext(CanvasContextStatus)
  const status = context.nodes[nodeId]
  const [confirming, setConfirming] = useState(false)
  if (onlySessionChanged && status?.state !== 'session-changed') {
    return null
  }
  const label =
    (!status || status.state === 'unverifiable' ? context.error : null) ??
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
            ? translate(
                'agentCanvas.contextSessionReplaced',
                'Session changed · context not shared'
              )
            : status?.state === 'unverifiable'
              ? translate('agentCanvas.contextUnverifiable', 'Context delivery is unverifiable')
              : translate('agentCanvas.contextWaiting', 'Waiting for the agent hook'))
  return (
    <>
      <span role="status">{label}</span>
      {status?.state === 'session-changed' && onAdoptSession && (
        <>
          <Button variant="link" size="xs" className="px-1" onClick={() => setConfirming(true)}>
            {translate('agentCanvas.adoptSession', 'Use current session')}
          </Button>
          <Dialog open={confirming} onOpenChange={setConfirming}>
            <DialogContent
              className="sm:max-w-md"
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.stopPropagation()
                  setConfirming(false)
                }
              }}
            >
              <DialogHeader>
                <DialogTitle>
                  {translate('agentCanvas.adoptSessionTitle', 'Connect the current agent session?')}
                </DialogTitle>
                <DialogDescription>
                  {translate(
                    'agentCanvas.adoptSessionDescription',
                    'Share this card’s attached notes and agent connections with the session now running in this terminal. Previous conversations will not be transferred.'
                  )}
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="ghost" onClick={() => setConfirming(false)}>
                  {translate('agentCanvas.cancel', 'Cancel')}
                </Button>
                <Button
                  onClick={() => {
                    setConfirming(false)
                    onAdoptSession(nodeId)
                  }}
                >
                  {translate('agentCanvas.adoptSession', 'Use current session')}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </>
      )}
    </>
  )
}
