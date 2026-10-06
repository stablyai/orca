import { Loader2 } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '../../store'
import { usePendingWebRuntimeTerminalCreates } from '../../runtime/pending-web-runtime-terminal-creates'
import { getTabRootStateClasses, getTabStripBorderClasses } from './drop-indicator'
import { TAB_LABEL_WIDTH_CLASSES } from './tab-width-rules'
import { useTabStripSlotProps } from './use-tab-strip-slot-props'

/**
 * Trailing placeholders for terminals a paired host is still creating. Like the client-hosted rows
 * they sit outside `orderedItems`: no tab exists yet, so there is nothing to drag, pin, or close.
 */
export default function PendingRemoteTerminalTabRows({
  worktreeId,
  groupId,
  includeTopTabBorder
}: {
  worktreeId: string
  groupId: string
  includeTopTabBorder: boolean
}): React.JSX.Element | null {
  const activeGroupId = useAppStore((state) => state.activeGroupIdByWorktree[worktreeId] ?? null)
  const rows = usePendingWebRuntimeTerminalCreates(worktreeId, groupId, activeGroupId)
  if (rows.length === 0) {
    return null
  }
  return (
    <>
      {rows.map((row, index) => (
        <PendingRemoteTerminalTab
          key={row.id}
          id={row.id}
          label={row.label}
          hasTabsToRight={index < rows.length - 1}
          includeTopTabBorder={includeTopTabBorder}
        />
      ))}
    </>
  )
}

function PendingRemoteTerminalTab({
  id,
  label,
  hasTabsToRight,
  includeTopTabBorder
}: {
  id: string
  label: string
  hasTabsToRight: boolean
  includeTopTabBorder: boolean
}): React.JSX.Element {
  const slotProps = useTabStripSlotProps(id, false)
  return (
    <div {...slotProps}>
      <Tooltip>
        <TooltipTrigger asChild>
          {/* Why the delayed fade: a fast host answers before it shows, so local-speed creates never flash. */}
          <div
            data-pending-remote-terminal-tab=""
            aria-busy="true"
            className={`relative flex h-full select-none items-center px-1.5 text-xs animate-in fade-in delay-200 fill-mode-both motion-reduce:animate-none ${getTabStripBorderClasses(hasTabsToRight, { includeTopBorder: includeTopTabBorder })} ${getTabRootStateClasses(false)}`}
          >
            <Loader2
              className="mr-1 size-3 shrink-0 text-muted-foreground motion-safe:animate-spin"
              aria-hidden
            />
            <span className={`${TAB_LABEL_WIDTH_CLASSES} mr-1`}>{label}</span>
          </div>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          {translate(
            'tabBar.pendingRemoteTerminal.tooltip',
            'Waiting for the remote host to start this terminal'
          )}
        </TooltipContent>
      </Tooltip>
    </div>
  )
}
