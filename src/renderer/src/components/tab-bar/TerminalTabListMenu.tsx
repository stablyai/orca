import { useRef } from 'react'
import { List } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { getTabDragLabel, type TabBarItem } from './tab-bar-item-model'

export function TerminalTabListMenu({
  items,
  activeId,
  generatedTitlesEnabled,
  onActivate
}: {
  items: readonly TabBarItem[]
  activeId: string | null
  generatedTitlesEnabled: boolean
  onActivate: (id: string) => void
}): React.JSX.Element {
  const selected = useRef<string | null>(null)
  const label = translate('multiplexer.terminalList', 'Terminal list')
  return (
    <DropdownMenu modal={false}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              className="my-auto ml-1 shrink-0"
              aria-label={label}
            >
              <List className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        align="end"
        className="max-h-80 w-72 overflow-y-auto scrollbar-sleek"
        onCloseAutoFocus={(event) => {
          if (selected.current) {
            event.preventDefault()
            onActivate(selected.current)
            selected.current = null
          }
        }}
      >
        <DropdownMenuRadioGroup
          value={activeId ?? ''}
          onValueChange={(id) => {
            selected.current = id
          }}
        >
          {items
            .filter((item) => item.type === 'terminal')
            .map((item) => (
              <DropdownMenuRadioItem
                key={item.id}
                value={item.id}
                className="break-all whitespace-normal"
              >
                {getTabDragLabel(item, generatedTitlesEnabled)}
              </DropdownMenuRadioItem>
            ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
