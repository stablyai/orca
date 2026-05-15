import { useEffect } from 'react'
import { ArrowLeft, HardDrive } from 'lucide-react'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { WorkspaceSpaceManagerPanel } from '../status-bar/WorkspaceSpaceManagerPanel'
import { useAppStore } from '../../store'

export default function WorkspaceSpacePage(): React.JSX.Element {
  const closeSpacePage = useAppStore((state) => state.closeSpacePage)

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) {
        return
      }
      // Why: confirmation dialogs own Escape first; page-level Escape should
      // only leave the full Space surface when no modal is active.
      if (document.querySelector('[role="dialog"]')) {
        return
      }
      event.preventDefault()
      closeSpacePage()
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [closeSpacePage])

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex shrink-0 items-center gap-3 border-b border-border px-5 py-3">
        <Button variant="outline" size="sm" onClick={closeSpacePage} className="shrink-0 gap-1.5">
          <ArrowLeft className="size-3.5" />
          Back
        </Button>
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-muted/30">
            <HardDrive className="size-4 text-muted-foreground" />
          </div>
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <h1 className="truncate text-base font-semibold text-foreground">Space</h1>
              <Badge variant="secondary">Beta</Badge>
            </div>
            <p className="truncate text-xs text-muted-foreground">
              Workspace disk usage and reclaimable worktree storage.
            </p>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-5 scrollbar-sleek">
        <div className="mx-auto max-w-7xl">
          <WorkspaceSpaceManagerPanel />
        </div>
      </div>
    </div>
  )
}
