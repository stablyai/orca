import { useCallback, useEffect, useState } from 'react'
import { HardDrive, RefreshCw, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import type { DockerCachedImage } from '../../../../shared/types'
import { Button } from '../ui/button'

type DockerImagesPaneProps = {
  initialImages?: DockerCachedImage[]
}

// Why: a stable module-level default keeps referential equality across renders
// (lint: react/no-object-type-as-default-prop).
const NO_INITIAL_IMAGES: DockerCachedImage[] = []

export function DockerImagesPane({
  initialImages = NO_INITIAL_IMAGES
}: DockerImagesPaneProps): React.JSX.Element {
  const [images, setImages] = useState<DockerCachedImage[]>(initialImages)
  const [loading, setLoading] = useState(initialImages.length === 0)
  const [pruningId, setPruningId] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      setImages(await window.api.docker.listCachedImages())
    } catch {
      toast.error('Could not load Docker images')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (initialImages.length > 0) {
      return
    }
    void refresh()
  }, [initialImages.length, refresh])

  const pruneImage = async (imageId: string): Promise<void> => {
    setPruningId(imageId)
    try {
      await window.api.docker.pruneImage(imageId)
      setImages((current) => current.filter((image) => image.id !== imageId))
      toast.success('Docker image pruned')
    } catch {
      toast.error('Could not prune Docker image')
    } finally {
      setPruningId(null)
    }
  }

  const totalBytes = images.reduce((sum, image) => sum + image.sizeBytes, 0)

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-4 rounded-lg border border-border/60 bg-muted/25 px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-background text-muted-foreground">
            <HardDrive className="size-4" />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-medium">{images.length} cached images</div>
            <div className="truncate text-xs text-muted-foreground">
              {formatBytes(totalBytes)} in Docker images built for isolated worktrees.
            </div>
          </div>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-8 shrink-0 gap-2 text-xs"
          onClick={() => void refresh()}
          disabled={loading}
        >
          <RefreshCw className={`size-3.5 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      <div className="overflow-hidden rounded-lg border border-border/60">
        <div className="grid grid-cols-[minmax(0,1fr)_7rem_8rem_5rem] gap-3 border-b border-border/60 bg-muted/30 px-4 py-2 text-xs font-medium text-muted-foreground">
          <div>Image</div>
          <div>Size</div>
          <div>Last used</div>
          <div className="text-right">Prune</div>
        </div>
        {images.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            {loading ? 'Loading Docker images...' : 'No cached Docker images.'}
          </div>
        ) : (
          <div className="divide-y divide-border/60">
            {images.map((image) => (
              <div
                key={image.id}
                className="grid grid-cols-[minmax(0,1fr)_7rem_8rem_5rem] items-center gap-3 px-4 py-3 text-sm"
              >
                <div className="min-w-0 space-y-1">
                  <div className="truncate font-mono text-xs">{shortImageId(image.id)}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {image.dockerfilePath}
                  </div>
                  <div className="truncate font-mono text-[11px] text-muted-foreground">
                    {image.cacheKey}
                  </div>
                </div>
                <div className="text-xs text-muted-foreground">{formatBytes(image.sizeBytes)}</div>
                <div className="text-xs text-muted-foreground">
                  {formatTimestamp(image.lastUsedAt)}
                </div>
                <div className="flex justify-end">
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="size-8 text-muted-foreground hover:text-destructive"
                    aria-label={`Prune Docker image ${shortImageId(image.id)}`}
                    disabled={pruningId === image.id}
                    onClick={() => void pruneImage(image.id)}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B'
  }
  const units = ['B', 'KB', 'MB', 'GB'] as const
  let value = bytes
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex++
  }
  return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`
}

function formatTimestamp(timestamp: number): string {
  if (!timestamp) {
    return 'Never'
  }
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }).format(new Date(timestamp))
}

function shortImageId(id: string): string {
  return id.replace(/^sha256:/, '').slice(0, 12)
}
