import React from 'react'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { isWebClientLocation } from '@/lib/web-client-location'
import { translate } from '@/i18n/i18n'
import { isDefaultSpaceId } from '../../../../shared/spaces'
import type { Space } from '../../../../shared/types'

type SpaceIndicatorProps = {
  space: Space
  active: boolean
  onActivate: (spaceId: string) => void
  onEdit: (spaceId: string) => void
  onDelete: (spaceId: string) => void
}

function SpaceIndicator({
  space,
  active,
  onActivate,
  onEdit,
  onDelete
}: SpaceIndicatorProps): React.JSX.Element {
  return (
    <ContextMenu>
      <Tooltip>
        <ContextMenuTrigger asChild>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-current={active ? 'true' : undefined}
              aria-label={space.name}
              onClick={() => onActivate(space.id)}
              className={cn(
                'group flex size-6 shrink-0 items-center justify-center rounded-md outline-hidden transition-colors hover:bg-worktree-sidebar-accent focus-visible:ring-[1.5px] focus-visible:ring-worktree-sidebar-ring',
                active && 'bg-worktree-sidebar-accent text-worktree-sidebar-accent-foreground'
              )}
            >
              {space.emoji ? (
                <span aria-hidden="true" className="text-sm leading-none">
                  {space.emoji}
                </span>
              ) : (
                <span
                  aria-hidden="true"
                  className={cn(
                    'rounded-full bg-current transition-[width,height,opacity]',
                    active ? 'size-1.5 opacity-80' : 'size-1 opacity-35 group-hover:opacity-60'
                  )}
                />
              )}
            </button>
          </TooltipTrigger>
        </ContextMenuTrigger>
        <TooltipContent side="top" sideOffset={4}>
          {space.name}
        </TooltipContent>
      </Tooltip>
      <ContextMenuContent className="min-w-[10rem]">
        <ContextMenuItem onSelect={() => onEdit(space.id)}>
          <Pencil />
          {translate('auto.components.sidebar.SidebarSpaceSwitcher.b025470e9f', 'Edit Space')}
        </ContextMenuItem>
        {!isDefaultSpaceId(space.id) ? (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem variant="destructive" onSelect={() => onDelete(space.id)}>
              <Trash2 />
              {translate('auto.components.sidebar.SidebarSpaceSwitcher.e3daa20b07', 'Delete Space')}
            </ContextMenuItem>
          </>
        ) : null}
      </ContextMenuContent>
    </ContextMenu>
  )
}

export const SidebarSpaceSwitcher = React.memo(
  function SidebarSpaceSwitcher(): React.JSX.Element | null {
    useTranslation()
    const spaces = useAppStore((s) => s.spaces)
    const activeSpaceId = useAppStore((s) => s.activeSpaceId)
    const setActiveSpace = useAppStore((s) => s.setActiveSpace)
    const openModal = useAppStore((s) => s.openModal)

    const handleEdit = React.useCallback(
      (spaceId: string) => openModal('space-editor', { spaceId }),
      [openModal]
    )
    const handleDelete = React.useCallback(
      (spaceId: string) => openModal('delete-space', { spaceId }),
      [openModal]
    )
    const handleCreate = React.useCallback(() => openModal('space-editor'), [openModal])

    const scrollRef = React.useRef<HTMLDivElement>(null)

    // Why: a newly created or shortcut-selected Space can sit outside the scrolled strip.
    React.useLayoutEffect(() => {
      const container = scrollRef.current
      const active = container?.querySelector('[aria-current="true"]')
      if (!container || !active) {
        return
      }
      const containerRect = container.getBoundingClientRect()
      const activeRect = active.getBoundingClientRect()
      // Why: stop short of the mask fade, otherwise the revealed indicator lands under it.
      const fade = 12
      if (activeRect.left - fade < containerRect.left) {
        container.scrollLeft -= containerRect.left - activeRect.left + fade
      } else if (activeRect.right + fade > containerRect.right) {
        container.scrollLeft += activeRect.right + fade - containerRect.right
      }
    }, [activeSpaceId, spaces])

    if (isWebClientLocation()) {
      return null
    }

    return (
      <div
        ref={scrollRef}
        role="group"
        aria-label={translate('auto.components.sidebar.SidebarSpaceSwitcher.spaces', 'Spaces')}
        className="sidebar-space-switcher-scroll min-w-0 flex-1 overflow-x-auto overscroll-x-contain"
      >
        <div className="flex w-max min-w-full items-center justify-center px-3">
          {spaces.map((space) => (
            <SpaceIndicator
              key={space.id}
              space={space}
              active={space.id === activeSpaceId}
              onActivate={setActiveSpace}
              onEdit={handleEdit}
              onDelete={handleDelete}
            />
          ))}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                type="button"
                aria-label={translate(
                  'auto.components.sidebar.SidebarSpaceSwitcher.bc5c35ca79',
                  'New Space'
                )}
                className="shrink-0 text-muted-foreground"
                onClick={handleCreate}
              >
                <Plus className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}>
              {translate('auto.components.sidebar.SidebarSpaceSwitcher.bc5c35ca79', 'New Space')}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>
    )
  }
)

export default SidebarSpaceSwitcher
