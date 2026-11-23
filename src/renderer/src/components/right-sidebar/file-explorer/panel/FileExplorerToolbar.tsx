import React from 'react'
import {
  Ellipsis,
  FilePlus,
  FolderPlus,
  ListCollapse,
  Loader2,
  RefreshCw,
  type LucideIcon
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { WorktreeOpenInMenuItems } from '@/components/sidebar/workspace-actions/open/WorktreeOpenInMenu'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'

type FileExplorerToolbarProps = {
  repoName: string
  worktreePath: string
  connectionId?: string | null
  runtimeEnvironmentId?: string | null
  ownerUnresolved?: boolean
  workspaceId?: string | null
  refresh: {
    isRefreshing: boolean
    showRefreshSpinner: boolean
    handleRefresh: () => void
  }
  canRefresh: boolean
  canCreate: boolean
  onStartNew: (type: 'file' | 'folder') => void
  canCollapseAll: boolean
  onCollapseAll: () => void
  showGitIgnoredFilesToggle: boolean
  showGitIgnoredFiles: boolean
  onToggleGitIgnoredFiles: () => void
  showDotfiles: boolean
  onToggleDotfiles: () => void
}

function formatOpenInAppLabel(appName: string): string {
  return translate(
    'auto.components.right.sidebar.FileExplorerToolbar.openInApp',
    'Open in {{app}}',
    {
      app: appName
    }
  )
}

function CreateButton({
  icon: Icon,
  labelKey,
  label,
  enabled,
  onClick
}: {
  icon: LucideIcon
  labelKey: string
  label: string
  enabled: boolean
  onClick: () => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className={cn(
            'text-muted-foreground hover:text-foreground',
            !enabled && 'cursor-not-allowed'
          )}
          aria-label={t(labelKey, label)}
          aria-disabled={!enabled}
          // Native disabled buttons suppress Radix tooltip triggers in Chromium.
          onClick={(event) => {
            if (!enabled) {
              event.preventDefault()
              return
            }
            onClick()
          }}
        >
          <Icon className="size-3" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={4}>
        {t(labelKey, label)}
      </TooltipContent>
    </Tooltip>
  )
}

export function FileExplorerToolbar({
  repoName,
  worktreePath,
  connectionId,
  runtimeEnvironmentId,
  ownerUnresolved,
  workspaceId,
  refresh,
  canRefresh,
  canCreate,
  onStartNew,
  canCollapseAll,
  onCollapseAll,
  showGitIgnoredFilesToggle,
  showGitIgnoredFiles,
  onToggleGitIgnoredFiles,
  showDotfiles,
  onToggleDotfiles
}: FileExplorerToolbarProps): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="flex h-8 min-h-8 items-center gap-2 border-b border-border px-2">
      <span
        className="min-w-0 flex-1 truncate text-xs font-medium text-foreground"
        title={repoName}
      >
        {repoName}
      </span>
      <CreateButton
        icon={FilePlus}
        labelKey="auto.components.right.sidebar.FileExplorerBackgroundMenu.21fe46ed36"
        label="New File"
        enabled={canCreate}
        onClick={() => onStartNew('file')}
      />
      <CreateButton
        icon={FolderPlus}
        labelKey="auto.components.right.sidebar.FileExplorerBackgroundMenu.3b5e2dcb8d"
        label="New Folder"
        enabled={canCreate}
        onClick={() => onStartNew('folder')}
      />
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className={cn(
              'text-muted-foreground hover:text-foreground',
              !canCollapseAll && 'cursor-not-allowed opacity-50'
            )}
            aria-label={t(
              'auto.components.right.sidebar.FileExplorerToolbar.6026b16950',
              'Collapse All'
            )}
            aria-disabled={!canCollapseAll}
            // Native disabled buttons suppress Radix tooltip triggers in Chromium.
            onClick={(event) => {
              if (!canCollapseAll) {
                event.preventDefault()
                return
              }
              onCollapseAll()
            }}
          >
            <ListCollapse className="size-3" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={4}>
          {t('auto.components.right.sidebar.FileExplorerToolbar.6026b16950', 'Collapse All')}
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className={cn(
              'text-muted-foreground hover:text-foreground',
              !canRefresh && 'cursor-not-allowed opacity-50'
            )}
            aria-label={t(
              'auto.components.right.sidebar.FileExplorerToolbar.d95e30fe28',
              'Refresh Explorer'
            )}
            aria-disabled={!canRefresh || refresh.isRefreshing}
            disabled={refresh.isRefreshing}
            onClick={(event) => {
              if (!canRefresh) {
                event.preventDefault()
                return
              }
              refresh.handleRefresh()
            }}
          >
            {refresh.showRefreshSpinner ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <RefreshCw className="size-3" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={4}>
          {t('auto.components.right.sidebar.FileExplorerToolbar.d95e30fe28', 'Refresh Explorer')}
        </TooltipContent>
      </Tooltip>
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="text-muted-foreground hover:text-foreground"
                aria-label={t(
                  'auto.components.right.sidebar.FileExplorerToolbar.31b4c3195d',
                  'More Explorer Actions'
                )}
              >
                <Ellipsis className="size-3" />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={4}>
            {t(
              'auto.components.right.sidebar.FileExplorerToolbar.31b4c3195d',
              'More Explorer Actions'
            )}
          </TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end" className="min-w-[12rem]">
          <DropdownMenuCheckboxItem checked={showDotfiles} onCheckedChange={onToggleDotfiles}>
            {t('auto.components.right.sidebar.FileExplorerToolbar.78f133232c', 'Show Dotfiles')}
          </DropdownMenuCheckboxItem>
          {showGitIgnoredFilesToggle ? (
            <DropdownMenuCheckboxItem
              checked={showGitIgnoredFiles}
              onCheckedChange={onToggleGitIgnoredFiles}
            >
              {t(
                'auto.components.right.sidebar.FileExplorerToolbar.d238264654',
                'Show Git Ignored Files'
              )}
            </DropdownMenuCheckboxItem>
          ) : null}
          <DropdownMenuSeparator />
          <WorktreeOpenInMenuItems
            worktreePath={worktreePath}
            connectionId={connectionId}
            runtimeEnvironmentId={runtimeEnvironmentId}
            ownerUnresolved={ownerUnresolved}
            workspace={workspaceId ? { workspaceId } : null}
            formatLabel={formatOpenInAppLabel}
          />
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
