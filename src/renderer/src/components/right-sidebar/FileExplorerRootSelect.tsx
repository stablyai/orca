import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { FILE_EXPLORER_FULL_ROOT, type ExplorerRootOption } from './file-explorer-display-root'

export type FileExplorerRootSelectProps = {
  options: ExplorerRootOption[]
  value: string
  onValueChange: (value: string) => void
  disabled: boolean
}

/** Exposes sparse-root choices with bounded path labels and a menu positioned outside the draggable titlebar. */
export function FileExplorerRootSelect({
  options,
  ...props
}: FileExplorerRootSelectProps): React.JSX.Element {
  const fullRootLabel = translate('fileExplorer.root.full', 'Full repo root')
  const selectedLabel =
    props.value === FILE_EXPLORER_FULL_ROOT
      ? fullRootLabel
      : (options.find((option) => option.value === props.value)?.label ?? props.value)
  return (
    <Select {...props}>
      <Tooltip>
        <TooltipTrigger asChild>
          <SelectTrigger
            size="sm"
            className="min-w-0 flex-1"
            aria-label={translate('fileExplorer.root.label', 'Explorer root')}
          >
            <SelectValue className="min-w-0">
              <span className="block min-w-0 truncate">{selectedLabel}</span>
            </SelectValue>
          </SelectTrigger>
        </TooltipTrigger>
        <TooltipContent className="max-w-sm [overflow-wrap:anywhere]">
          {selectedLabel}
        </TooltipContent>
      </Tooltip>
      <SelectContent
        position="popper"
        side="bottom"
        align="start"
        sideOffset={4}
        collisionPadding={8}
        className="w-80 max-w-[var(--radix-select-content-available-width)] [-webkit-app-region:no-drag]"
      >
        {options.map((option) => (
          <SelectItem
            key={option.value}
            value={option.value}
            className="[&>span:last-child]:min-w-0"
          >
            <span className="block min-w-0 whitespace-normal [overflow-wrap:anywhere]">
              {option.value === FILE_EXPLORER_FULL_ROOT ? fullRootLabel : option.label}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
