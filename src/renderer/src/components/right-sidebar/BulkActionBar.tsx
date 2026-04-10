import { Plus, Minus, X, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'

export function BulkActionBar({
  selectedCount,
  stageableCount,
  unstageableCount,
  onStage,
  onUnstage,
  onClear,
  isExecuting
}: {
  selectedCount: number
  stageableCount: number
  unstageableCount: number
  onStage: () => void
  onUnstage: () => void
  onClear: () => void
  isExecuting: boolean
}) {
  return (
    <div className="absolute bottom-0 left-0 right-0 p-2 bg-background/95 backdrop-blur-sm border-t border-border shadow-lg animate-in slide-in-from-bottom-2 z-10">
      <div className="flex items-center gap-2 justify-between bg-accent/30 p-1.5 pr-2 rounded-md border border-border/50">
        <div className="flex items-center gap-2 text-xs font-medium text-foreground ml-1">
          {isExecuting ? (
            <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
          ) : (
            <span className="tabular-nums">{selectedCount} selected</span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {stageableCount > 0 && (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="h-7 px-2 text-[11px]"
              onClick={onStage}
              disabled={isExecuting}
            >
              <Plus className="mr-1 size-3" />
              Stage ({stageableCount})
            </Button>
          )}
          {unstageableCount > 0 && (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="h-7 px-2 text-[11px]"
              onClick={onUnstage}
              disabled={isExecuting}
            >
              <Minus className="mr-1 size-3" />
              Unstage ({unstageableCount})
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 ml-0.5 text-muted-foreground hover:text-foreground hover:bg-muted"
            onClick={onClear}
            disabled={isExecuting}
          >
            <X className="size-3.5" />
          </Button>
        </div>
      </div>
    </div>
  )
}
