import { useState } from 'react'
import { ArrowRight, Check, ChevronDown, TerminalSquare } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { translate } from '@/i18n/i18n'
import type { CanvasDocument } from './agent-canvas-document'

export function AgentCanvasConnectMenu({
  sourceId,
  document,
  disabled,
  onConnect
}: {
  sourceId: string
  document: CanvasDocument
  disabled: boolean
  onConnect: (source: string, target: string) => void
}) {
  const [open, setOpen] = useState(false)
  const peerConnection = document.nodes.find((node) => node.id === sourceId)?.kind === 'agent'
  const targets = open
    ? document.nodes.filter((node) => node.kind === 'agent' && node.id !== sourceId)
    : []
  return (
    <div
      className="flex min-w-0 items-center gap-1"
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            disabled={disabled}
            aria-label={translate('agentCanvas.chooseAgentList', 'Choose agent from list')}
          >
            <ChevronDown />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-72 p-0" align="start">
          <div className="border-b border-border px-3 py-2 text-xs text-muted-foreground">
            {peerConnection
              ? translate(
                  'agentCanvas.chooseTeammate',
                  'Choose an agent to collaborate with in both directions.'
                )
              : translate(
                  'agentCanvas.chooseRecipient',
                  'Choose the agent that receives this context.'
                )}
          </div>
          <Command>
            <CommandInput
              placeholder={translate(
                'agentCanvas.searchRecipient',
                'Search agents on this canvas…'
              )}
            />
            <CommandList>
              <CommandEmpty>
                {translate(
                  'agentCanvas.noRecipient',
                  'Add another agent to this canvas, or open an existing connection.'
                )}
              </CommandEmpty>
              {targets.map((target) => {
                const connected = document.edges.some(
                  (edge) =>
                    (edge.source === sourceId && edge.target === target.id) ||
                    (peerConnection && edge.target === sourceId && edge.source === target.id)
                )
                return (
                  <CommandItem
                    key={target.id}
                    value={`${target.title} ${target.id}`}
                    onSelect={() => {
                      setOpen(false)
                      onConnect(sourceId, target.id)
                    }}
                  >
                    <TerminalSquare className="size-3.5" />
                    <span className="min-w-0 flex-1 truncate">{target.title}</span>
                    {connected ? (
                      <>
                        <Check className="size-3.5" />
                        <span className="text-[11px]">
                          {translate('agentCanvas.connectedReview', 'Connected · review')}
                        </span>
                      </>
                    ) : (
                      <ArrowRight className="size-3.5" />
                    )}
                  </CommandItem>
                )
              })}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  )
}
