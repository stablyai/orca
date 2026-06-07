import React from 'react'
import { ChevronRight, Settings2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'

/**
 * Gear affordance on the workspace Name label row. Its popover explains that a
 * blank name lets Orca auto-name the workspace title and branch from the work,
 * and lets the user flip the `autoRenameBranchFromWork` setting inline without
 * leaving the composer. Only relevant for git repos, where a branch exists.
 */
export default function AutoRenameBranchHint(): React.JSX.Element {
  const autoRenameBranchFromWork = useAppStore((s) => s.settings?.autoRenameBranchFromWork ?? false)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  const closeModal = useAppStore((s) => s.closeModal)

  const handleOpenSettings = React.useCallback((): void => {
    // Why: the toggle lives in the Git settings page (Git AI Author pane);
    // closing the composer first keeps it from rendering behind the modal.
    closeModal()
    openSettingsTarget({ pane: 'git', repoId: null })
    openSettingsPage()
  }, [closeModal, openSettingsPage, openSettingsTarget])

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          // Why: detour from the Name → Agent tab flow, so keep it off the tab
          // order like the adjacent agent-settings gear.
          tabIndex={-1}
          className="size-5 shrink-0 rounded-sm text-muted-foreground hover:text-foreground data-[state=open]:text-foreground"
          aria-label="Auto-name settings"
        >
          <Settings2 className="size-3" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" side="bottom" sideOffset={6} className="w-72 p-3">
        <div className="space-y-2.5">
          <div className="space-y-1">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-medium text-foreground">Auto-name from work</span>
              <button
                type="button"
                role="switch"
                aria-checked={autoRenameBranchFromWork}
                aria-label="Auto-name from work"
                onClick={() =>
                  updateSettings({ autoRenameBranchFromWork: !autoRenameBranchFromWork })
                }
                className={cn(
                  'relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors',
                  autoRenameBranchFromWork ? 'bg-foreground' : 'bg-muted-foreground/30'
                )}
              >
                <span
                  className={cn(
                    'pointer-events-none block size-3.5 rounded-full bg-background shadow-sm transition-transform',
                    autoRenameBranchFromWork ? 'translate-x-4' : 'translate-x-0.5'
                  )}
                />
              </button>
            </div>
            <p className="text-xs text-muted-foreground">
              When you leave the name blank, Orca uses the first task to rename the sidebar title
              and unpublished generated branch.
            </p>
          </div>

          <button
            type="button"
            onClick={handleOpenSettings}
            className="flex items-center gap-0.5 rounded-sm text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            Open settings
            <ChevronRight className="size-3" />
          </button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
