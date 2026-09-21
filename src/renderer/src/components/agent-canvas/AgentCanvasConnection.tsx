import { useRef, useState } from 'react'
import { Loader2, Send, Unplug, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import type { DashboardCard } from '../../../../shared/dashboard-snapshot'
import { canvasContext, type CanvasNode } from './agent-canvas-document'
import { sendCanvasContext } from './agent-canvas-delivery'
import { AgentCanvasContextStatus } from './AgentCanvasContextStatus'
import { AgentCanvasConversation } from './AgentCanvasConversation'

export function AgentCanvasConnection({
  source,
  scope,
  paused,
  browserControl = false,
  target,
  sourceCard,
  targetCard,
  readOnly,
  onClose,
  onRemove
}: {
  source: CanvasNode
  scope?: string
  paused?: boolean
  browserControl?: boolean
  target: CanvasNode
  sourceCard?: DashboardCard
  targetCard?: DashboardCard
  readOnly: boolean
  onClose: () => void
  onRemove: () => void
}) {
  const [prompt, setPrompt] = useState(() => canvasContext(source, sourceCard))
  const [sending, setSending] = useState(false)
  const busy = useRef(false)
  const [result, setResult] = useState<{ error: boolean; message: string } | null>(null)
  const isNote = source.kind === 'note'
  const send = async (): Promise<void> => {
    if (busy.current || readOnly || !targetCard || !prompt.trim()) {
      return
    }
    busy.current = true
    setSending(true)
    setResult(null)
    try {
      await sendCanvasContext(targetCard, prompt.trim())
      setResult({
        error: false,
        message: translate('agentCanvas.sent', 'Context submitted to the agent.')
      })
    } catch (error) {
      setResult({ error: true, message: error instanceof Error ? error.message : String(error) })
    } finally {
      busy.current = false
      setSending(false)
    }
  }
  if (source.kind === 'agent' && target.kind === 'agent') {
    return (
      <AgentCanvasConversation
        source={source}
        target={target}
        scope={scope}
        paused={paused}
        readOnly={readOnly}
        onClose={onClose}
        onRemove={onRemove}
      />
    )
  }
  return (
    <aside
      className="flex max-h-[min(32rem,70vh)] flex-col gap-3 overflow-y-auto p-3 scrollbar-sleek"
      aria-label={translate('agentCanvas.connection', 'Connection')}
    >
      <div className="flex items-center gap-2 text-[13px] font-medium">
        <span className="min-w-0 flex-1 break-words">
          {source.title} → {target.title}
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={onClose}
              aria-label={translate('agentCanvas.closeConnection', 'Close connection details')}
            >
              <X />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {translate('agentCanvas.closeConnection', 'Close connection details')}
          </TooltipContent>
        </Tooltip>
      </div>
      {browserControl && source.kind === 'browser' ? (
        <>
          <p className="text-xs text-muted-foreground">
            {translate(
              'agentCanvas.browserControlHint',
              'Created by this agent. Its browser commands control the page shown in this card.'
            )}
          </p>
          <p className="break-words text-xs">{source.content}</p>
        </>
      ) : isNote ? (
        <>
          <p className="text-xs text-muted-foreground">
            <AgentCanvasContextStatus nodeId={target.id} />
          </p>
          <div
            aria-label={translate('agentCanvas.linkedNote', 'Linked note')}
            className="scrollbar-sleek max-h-60 overflow-y-auto whitespace-pre-wrap text-sm leading-relaxed"
          >
            {source.content ||
              translate(
                'agentCanvas.emptyNote',
                'This note is empty. Write context in the note card.'
              )}
          </div>
          <p className="text-xs text-muted-foreground">
            {translate(
              'agentCanvas.contextRemovalHint',
              'Disconnecting stops future snapshots; it does not erase context already received.'
            )}
          </p>
        </>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            {translate(
              'agentCanvas.manualConnectionHint',
              'One-way context sharing. Nothing is sent until you choose Send context.'
            )}
          </p>
          <Textarea
            aria-label={translate('agentCanvas.context', 'Context to send')}
            className="scrollbar-sleek h-40 shrink-0 resize-y text-xs"
            value={prompt}
            disabled={sending || readOnly}
            maxLength={100_000}
            onChange={(event) => setPrompt(event.target.value)}
          />
          {!targetCard?.ptyId && (
            <p className="text-xs text-muted-foreground">
              {translate(
                'agentCanvas.recipientUnavailable',
                'Recipient terminal unavailable. Reconnect its workspace to send context.'
              )}
            </p>
          )}
          <Button
            variant="ghost"
            size="xs"
            disabled={sending}
            onClick={() => setPrompt(canvasContext(source, sourceCard))}
          >
            {translate('agentCanvas.refreshContext', 'Use latest source content')}
          </Button>
          {result && (
            <p
              role="status"
              className={
                result.error ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'
              }
            >
              {result.message}
            </p>
          )}
          <Button
            size="sm"
            disabled={readOnly || sending || !targetCard?.ptyId || !prompt.trim()}
            onClick={() => void send()}
          >
            {sending ? <Loader2 className="animate-spin" /> : <Send />}
            {translate('agentCanvas.sendContext', 'Send context')}
          </Button>
        </>
      )}
      <Button variant="ghost" size="sm" disabled={readOnly || sending} onClick={onRemove}>
        <Unplug />
        {translate('agentCanvas.disconnect', 'Disconnect')}
      </Button>
    </aside>
  )
}
