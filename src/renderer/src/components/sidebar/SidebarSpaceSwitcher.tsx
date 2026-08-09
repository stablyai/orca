import React from 'react'
import { ChevronDown, Pencil, Plus, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '@/store'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { isWebClientLocation } from '@/lib/web-client-location'
import { translate } from '@/i18n/i18n'
import {
  DEFAULT_SPACE_ID,
  DEFAULT_SPACE_FALLBACK_NAME,
  getSpaceById,
  hasCustomSpaces,
  isDefaultSpaceId
} from '../../../../shared/spaces'

type SidebarSpaceSwitcherProps = {
  fallbackTitle: string
  sectionTitle: 'projects' | 'workspaces'
}

export const SidebarSpaceSwitcher = React.memo(function SidebarSpaceSwitcher({
  fallbackTitle,
  sectionTitle
}: SidebarSpaceSwitcherProps): React.JSX.Element {
  useTranslation()
  const spaces = useAppStore((s) => s.spaces)
  const activeSpaceId = useAppStore((s) => s.activeSpaceId)
  const setActiveSpace = useAppStore((s) => s.setActiveSpace)
  const openModal = useAppStore((s) => s.openModal)

  const customSpaces = hasCustomSpaces(spaces)
  const catalogActiveSpace = getSpaceById(spaces, activeSpaceId)
  const defaultCustomized =
    catalogActiveSpace?.id === DEFAULT_SPACE_ID &&
    (catalogActiveSpace.name !== DEFAULT_SPACE_FALLBACK_NAME || catalogActiveSpace.emoji !== null)
  const activeSpace = customSpaces || defaultCustomized ? catalogActiveSpace : undefined
  const deletable = activeSpace !== undefined && !isDefaultSpaceId(activeSpace.id)
  const anyEmoji = spaces.some((space) => space.emoji)

  const handleEdit = React.useCallback(
    () => openModal('space-editor', { spaceId: activeSpaceId }),
    [openModal, activeSpaceId]
  )
  const handleDelete = React.useCallback(
    () => openModal('delete-space', { spaceId: activeSpaceId }),
    [openModal, activeSpaceId]
  )
  const handleCreate = React.useCallback(() => openModal('space-editor'), [openModal])

  if (isWebClientLocation()) {
    return (
      <span
        className="truncate pl-2 pr-0.5 text-xs font-semibold text-muted-foreground/80 select-none"
        data-sidebar-section-title={sectionTitle}
      >
        {fallbackTitle}
      </span>
    )
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-sidebar-space-switcher=""
          data-space-id={activeSpace?.id}
          aria-label={translate(
            activeSpace
              ? 'auto.components.sidebar.SidebarSpaceSwitcher.currentSwitcherLabel'
              : 'auto.components.sidebar.SidebarSpaceSwitcher.switcherLabel',
            activeSpace ? 'Spaces: {{value0}}' : 'Spaces',
            activeSpace ? { value0: activeSpace.name } : undefined
          )}
          className="group flex h-6 min-w-0 items-center gap-1 rounded-md pr-1 text-xs font-semibold text-muted-foreground/80 outline-hidden select-none transition-colors hover:text-worktree-sidebar-accent-foreground focus-visible:ring-[1.5px] focus-visible:ring-worktree-sidebar-ring data-[state=open]:text-worktree-sidebar-accent-foreground"
        >
          {activeSpace?.emoji ? (
            <span aria-hidden="true" className="pl-2 text-sm leading-none">
              {activeSpace.emoji}
            </span>
          ) : null}
          <span
            className={cn('truncate', activeSpace?.emoji ? undefined : 'pl-2')}
            data-sidebar-section-title={sectionTitle}
          >
            {activeSpace?.name ?? fallbackTitle}
          </span>
          <ChevronDown
            aria-hidden="true"
            className={cn(
              'size-3 shrink-0 transition-opacity group-hover:opacity-70 group-data-[state=open]:opacity-70',
              activeSpace ? 'opacity-60' : 'opacity-0'
            )}
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={2} className="min-w-[13rem]">
        {customSpaces ? (
          <>
            <DropdownMenuRadioGroup value={activeSpaceId} onValueChange={setActiveSpace}>
              {spaces.map((space) => (
                <DropdownMenuRadioItem key={space.id} value={space.id} data-space-id={space.id}>
                  {anyEmoji ? (
                    <span aria-hidden="true" className="w-4 shrink-0 text-sm leading-none">
                      {space.emoji}
                    </span>
                  ) : null}
                  <span className="truncate">{space.name}</span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
          </>
        ) : null}
        <DropdownMenuItem onSelect={handleEdit}>
          <Pencil />
          {translate('auto.components.sidebar.SidebarSpaceSwitcher.editSpace', 'Edit Space')}
        </DropdownMenuItem>
        {deletable ? (
          <DropdownMenuItem variant="destructive" onSelect={handleDelete}>
            <Trash2 />
            {translate('auto.components.sidebar.SidebarSpaceSwitcher.deleteSpace', 'Delete Space')}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem data-new-space-trigger="" onSelect={handleCreate}>
          <Plus />
          {translate('auto.components.sidebar.SidebarSpaceSwitcher.newSpace', 'New Space')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
})

export default SidebarSpaceSwitcher
