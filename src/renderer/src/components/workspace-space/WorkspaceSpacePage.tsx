import { useEffect } from 'react'
import { ArrowLeft, HardDrive } from 'lucide-react'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { WorkspaceSpaceManagerPanel } from '../status-bar/WorkspaceSpaceManagerPanel'
import { useAppStore } from '../../store'

export default function WorkspaceSpacePage(): React.JSX.Element {
  const closeSpacePage = useAppStore((state) => state.closeSpacePage)

  useEffect(() => {
    const hasVisibleOverlay = (): boolean =>
      Array.from(
        document.querySelectorAll('[role="dialog"], [role="listbox"], [role="menu"]')
      ).some((element) => {
        if (!(element instanceof HTMLElement)) {
          return false
        }
        if (element.closest('[aria-hidden="true"]')) {
          return false
        }
        const style = window.getComputedStyle(element)
        return (
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          element.getClientRects().length > 0
        )
      })

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') {
        return
      }
      // Why: confirmation dialogs own Escape first; page-level Escape should
      // only leave the full Space surface when no modal or popover is active.
      if (hasVisibleOverlay()) {
        return
      }
      const target = event.target as HTMLElement | null
      if (
        target?.matches('input, textarea, select, [contenteditable="true"], [contenteditable=""]')
      ) {
        return
      }
      event.preventDefault()
      closeSpacePage()
    }

    // Why: tooltips can consume Escape before bubble listeners see it. Capture
    // keeps the first Escape reliable while still deferring to real overlays.
    window.addEventListener('keydown', handleKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true })
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
