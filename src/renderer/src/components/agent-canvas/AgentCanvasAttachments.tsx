import { useState } from 'react'
import { Paperclip, StickyNote } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { translate } from '@/i18n/i18n'
import type { CanvasDocument } from './agent-canvas-document'
import { AgentCanvasContextStatus } from './AgentCanvasContextStatus'

export function AgentCanvasAttachments({
  nodeId,
  document,
  onConnect
}: {
  nodeId: string
  document: CanvasDocument
  onConnect: (source: string, target: string) => void
}) {
  const [open, setOpen] = useState(false)
  const ids = new Set(
    document.edges.filter((edge) => edge.target === nodeId).map((edge) => edge.source)
  )
  const notes = document.nodes.filter((node) => ids.has(node.id) && node.kind === 'note')
  if (!notes.length) {
    return null
  }
  return (
    <div
      className="nodrag nopan shrink-0 border-t border-border px-3 pt-2"
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="xs"
            className="max-w-full justify-start px-1"
            aria-label={translate('agentCanvas.attachedNotes', 'Attached notes')}
          >
            <Paperclip className="size-3.5" />
            <span className="truncate">{notes.map((note) => note.title).join(', ')}</span>
            <span className="text-muted-foreground">{notes.length}</span>
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-72 p-3" align="start">
          <p className="text-xs font-medium">
            {translate('agentCanvas.attachedNotes', 'Attached notes')}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            <AgentCanvasContextStatus nodeId={nodeId} />
          </p>
          <div className="mt-2 flex max-h-48 flex-col overflow-y-auto scrollbar-sleek">
            {notes.map((note) => (
              <Button
                key={note.id}
                variant="ghost"
                size="sm"
                className="justify-start"
                onClick={() => {
                  setOpen(false)
                  onConnect(note.id, nodeId)
                }}
              >
                <StickyNote className="size-3.5" />
                <span className="truncate">{note.title}</span>
              </Button>
            ))}
          </div>
        </PopoverContent>
      </Popover>
      <p className="pb-1 text-[11px] text-muted-foreground">
        <AgentCanvasContextStatus nodeId={nodeId} />
      </p>
    </div>
  )
}
