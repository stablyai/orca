import React from 'react'
import { Download, FolderPlus, Settings, X } from 'lucide-react'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'

const SidebarToolbar = React.memo(function SidebarToolbar() {
  const addRepo = useAppStore((s) => s.addRepo)
  const setActiveView = useAppStore((s) => s.setActiveView)
  const updateStatus = useAppStore((s) => s.updateStatus)
  const dismissedUpdateVersion = useAppStore((s) => s.dismissedUpdateVersion)
  const dismissUpdate = useAppStore((s) => s.dismissUpdate)

  const updateVersion = 'version' in updateStatus ? updateStatus.version : null
  const showUpdateBanner =
    (updateStatus.state === 'downloaded' ||
      updateStatus.state === 'available' ||
      updateStatus.state === 'downloading') &&
    updateVersion !== dismissedUpdateVersion

  return (
    <div className="mt-auto shrink-0">
      {showUpdateBanner && (
        <div className="flex items-center border-t border-sidebar-border bg-primary/10">
          <button
            onClick={() => {
              if (updateStatus.state === 'downloaded') {
                window.api.updater.quitAndInstall()
              } else if (updateStatus.state === 'available') {
                window.api.updater.download()
              }
            }}
            disabled={updateStatus.state === 'downloading'}
            className="flex items-center gap-1.5 flex-1 min-w-0 px-2 py-1.5 text-[11px] font-medium text-primary hover:bg-primary/15 transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-default"
          >
            <Download className="size-3.5 shrink-0" />
            {updateStatus.state === 'downloaded' ? (
              <span>Restart now (update)</span>
            ) : updateStatus.state === 'downloading' ? (
              <span>
                Downloading <span className="font-semibold">v{updateVersion}</span>…{' '}
                {updateStatus.percent}%
              </span>
            ) : (
              <span>
                Update <span className="font-semibold">v{updateStatus.version}</span> available —
                Install
              </span>
            )}
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation()
              dismissUpdate()
            }}
            className="shrink-0 p-1 mr-1 rounded text-primary/60 hover:text-primary hover:bg-primary/15 transition-colors"
            title="Dismiss"
          >
            <X className="size-3" />
          </button>
        </div>
      )}
      <div className="flex items-center justify-between px-2 py-1.5 border-t border-sidebar-border">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="xs"
              onClick={() => addRepo()}
              className="gap-1.5 text-muted-foreground"
            >
              <FolderPlus className="size-3.5" />
              <span className="text-[11px]">Add Repo</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            Open folder picker to add a repo
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => setActiveView('settings')}
              className="text-muted-foreground"
            >
              <Settings className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            Settings
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  )
})

export default SidebarToolbar
