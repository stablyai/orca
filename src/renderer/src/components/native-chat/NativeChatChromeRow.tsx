import { ChevronsDownUp, ChevronsUpDown } from 'lucide-react'
import { translate } from '@/i18n/i18n'

/**
 * The row locked to the top of the composer area for transcript-wide controls.
 * The stop action lives in the composer submit button so the primary action
 * stays in one predictable place.
 */
export function NativeChatChromeRow({
  toolsExpanded,
  onToggleTools
}: {
  toolsExpanded: boolean
  onToggleTools: () => void
}): React.JSX.Element {
  return (
    <div className="mx-auto flex w-full max-w-3xl items-center gap-2 px-3 py-1 sm:px-4">
      <button
        type="button"
        onClick={onToggleTools}
        aria-pressed={toolsExpanded}
        className="flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {toolsExpanded ? (
          <ChevronsDownUp className="size-3.5" />
        ) : (
          <ChevronsUpDown className="size-3.5" />
        )}
        <span>
          {toolsExpanded
            ? translate('components.native-chat.tool.collapseAll', 'Collapse tool calls')
            : translate('components.native-chat.tool.expandAll', 'Expand tool calls')}
        </span>
      </button>
    </div>
  )
}
