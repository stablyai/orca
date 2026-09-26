import { ChevronDown, RefreshCw, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ButtonGroup } from '@/components/ui/button-group'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'

export function ConversationKnowledgeIndexButton({
  running,
  disabled,
  onGenerateUpdates,
  onRegenerateAll,
  onStop
}: {
  running: boolean
  disabled: boolean
  onGenerateUpdates: () => void
  onRegenerateAll: () => void
  onStop: () => void
}): React.JSX.Element {
  return (
    <ButtonGroup>
      <Button
        size="sm"
        variant="outline"
        disabled={disabled}
        onClick={running ? onStop : onGenerateUpdates}
      >
        {running ? <Square /> : <RefreshCw />}
        {running
          ? translate('conversationKnowledge.stop', 'Stop generating')
          : translate('conversationKnowledge.generateUpdates', 'Generate updates')}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="icon-sm"
            variant="outline"
            disabled={disabled || running}
            aria-label={translate(
              'conversationKnowledge.generationOptions',
              'More generation options'
            )}
          >
            <ChevronDown className="size-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={onRegenerateAll} className="items-start">
            <RefreshCw className="mt-0.5" />
            <span>
              <span className="block">
                {translate('conversationKnowledge.regenerateAll', 'Regenerate all')}
              </span>
              <span className="block text-[11px] text-muted-foreground">
                {translate(
                  'conversationKnowledge.regenerateAllDescription',
                  'Replace every generated knowledge item.'
                )}
              </span>
            </span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </ButtonGroup>
  )
}
