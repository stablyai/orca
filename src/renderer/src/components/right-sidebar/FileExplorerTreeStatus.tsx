import React from 'react'
import { Loader2 } from 'lucide-react'

type FileExplorerTreeStatusProps = {
  isLoading: boolean
  error: string | null
  isEmpty: boolean
}

export function FileExplorerTreeStatus({
  isLoading,
  error,
  isEmpty
}: FileExplorerTreeStatusProps): React.JSX.Element | null {
  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-[11px] text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center text-[11px] text-muted-foreground">
        Could not load files for this worktree: {error}
      </div>
    )
  }

  if (isEmpty) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center text-[11px] text-muted-foreground">
        No files in this worktree
      </div>
    )
  }

  return null
}
