import { Link2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { CanvasDocument, CanvasNode } from './agent-canvas-document'

export function AgentCanvasConnectionPrompt({
  source,
  document,
  onCancel
}: {
  source: CanvasNode
  document: CanvasDocument
  onCancel: () => void
}) {
  const hasAgent = document.nodes.some((node) => node.kind === 'agent' && node.id !== source.id)
  return (
    <div className="absolute bottom-14 left-3 right-3 z-20 flex items-center gap-2 rounded-md border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-xs">
      <Link2 className="size-4 shrink-0" />
      <div role="status" className="min-w-0 flex-1">
        <span className="font-medium">{source.title}</span>
        <span>
          {' '}
          ·{' '}
          {hasAgent
            ? translate('agentCanvas.dropOnAgent', 'Release on an agent card to connect.')
            : translate(
                'agentCanvas.addRecipientFirst',
                'Add an agent with New agent above, then drag this point to its card.'
              )}
        </span>
      </div>
      <Button variant="ghost" size="xs" onClick={onCancel}>
        {translate('agentCanvas.cancelConnection', 'Cancel connection')}
      </Button>
    </div>
  )
}
