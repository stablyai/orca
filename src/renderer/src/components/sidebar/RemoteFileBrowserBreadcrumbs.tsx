import React, { useCallback } from 'react'
import { ChevronRight, ArrowUp, Home } from 'lucide-react'
import { cn } from '@/lib/utils'
import { driveBreadcrumbPath, splitBrowsePath } from './remote-file-browser-drive-paths'
import { parentPath } from './remote-file-browser-helpers'
import type { FilesystemPathFlavor } from '../../../../shared/filesystem-entry-types'

type RemoteFileBrowserBreadcrumbsProps = {
  resolvedPath: string
  pathFlavor: FilesystemPathFlavor
  loading: boolean
  navigate: (dirPath: string) => void
  navigateUp: () => void
}

/** Breadcrumb bar */
export function RemoteFileBrowserBreadcrumbs({
  resolvedPath,
  pathFlavor,
  loading,
  navigate,
  navigateUp
}: RemoteFileBrowserBreadcrumbsProps): React.JSX.Element {
  // Preserve the separator shape when rebuilding drive breadcrumbs.
  const browseParts = splitBrowsePath(resolvedPath, pathFlavor)
  const pathSegments = browseParts.segments
  const anchorRoot =
    browseParts.kind === 'drive'
      ? browseParts.driveRoot
      : browseParts.kind === 'unc'
        ? browseParts.uncRoot
        : null
  const breadcrumbPathTo = useCallback(
    (segmentIndex: number): string =>
      anchorRoot !== null
        ? driveBreadcrumbPath(anchorRoot, browseParts.segments, segmentIndex)
        : `/${browseParts.segments.slice(0, segmentIndex + 1).join('/')}`,
    [anchorRoot, browseParts]
  )

  return (
    <div className="flex items-center gap-0.5 min-h-[28px] overflow-x-auto scrollbar-none">
      <button
        type="button"
        onClick={navigateUp}
        disabled={parentPath(resolvedPath, pathFlavor) === resolvedPath || loading}
        className="shrink-0 p-1 rounded hover:bg-accent disabled:opacity-30 transition-colors cursor-pointer disabled:cursor-default"
      >
        <ArrowUp className="size-3.5" />
      </button>
      <button
        type="button"
        onClick={() => navigate('~')}
        disabled={loading}
        className="shrink-0 p-1 rounded hover:bg-accent transition-colors cursor-pointer"
      >
        <Home className="size-3.5" />
      </button>
      <div className="flex items-center gap-0 text-[11px] text-muted-foreground ml-1 min-w-0">
        {browseParts.kind !== 'unc' && (
          <button
            type="button"
            onClick={() => navigate('/')}
            className="shrink-0 hover:text-foreground transition-colors cursor-pointer px-0.5"
          >
            /
          </button>
        )}
        {anchorRoot !== null && (
          <>
            {browseParts.kind === 'drive' && (
              <ChevronRight className="size-2.5 shrink-0 text-muted-foreground/50" />
            )}
            <button
              type="button"
              onClick={() => navigate(anchorRoot)}
              className={cn(
                'truncate max-w-[120px] hover:text-foreground transition-colors cursor-pointer px-0.5',
                pathSegments.length === 0 && 'text-foreground font-medium'
              )}
            >
              {browseParts.kind === 'drive' ? anchorRoot.slice(0, 2) : anchorRoot.slice(0, -1)}
            </button>
          </>
        )}
        {pathSegments.map((segment, i) => (
          <React.Fragment key={breadcrumbPathTo(i)}>
            <ChevronRight className="size-2.5 shrink-0 text-muted-foreground/50" />
            <button
              type="button"
              onClick={() => navigate(breadcrumbPathTo(i))}
              className={cn(
                'truncate max-w-[120px] hover:text-foreground transition-colors cursor-pointer px-0.5',
                i === pathSegments.length - 1 && 'text-foreground font-medium'
              )}
            >
              {segment}
            </button>
          </React.Fragment>
        ))}
      </div>
    </div>
  )
}
