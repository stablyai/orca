import { Suspense, useEffect, useState } from 'react'
import { AlertCircle, Loader2 } from 'lucide-react'
import type { CanvasCard } from '@/store/slices/canvas'
import { MarkdownPreview } from '@/components/editor/editor-lazy-views'
import { getConnectionIdForFileFromState } from '@/lib/connection-owner-resolution'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'

export function CanvasMarkdownCard({ card }: { card: CanvasCard }): React.JSX.Element {
  const [content, setContent] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let disposed = false
    setContent(null)
    setFailed(false)
    const connectionId =
      getConnectionIdForFileFromState(useAppStore.getState(), card.worktreeId, card.filePath) ??
      undefined
    window.api.fs
      .readFile({ filePath: card.filePath, ...(connectionId ? { connectionId } : {}) })
      .then((result) => {
        if (!disposed) {
          setContent(result.content)
        }
      })
      .catch(() => {
        if (!disposed) {
          setFailed(true)
        }
      })
    return () => {
      disposed = true
    }
  }, [card.worktreeId, card.filePath])

  if (failed) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
        <AlertCircle className="size-5 text-muted-foreground" />
        <p className="text-xs text-muted-foreground">
          {translate('auto.components.canvas-page.readFailed', 'Could not read this file.')}
        </p>
      </div>
    )
  }
  if (content === null) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    )
  }
  return (
    <div className="h-full overflow-auto scrollbar-editor">
      <Suspense
        fallback={
          <div className="flex h-full items-center justify-center">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        }
      >
        <MarkdownPreview
          content={content}
          filePath={card.filePath}
          sourceWorktreeId={card.worktreeId}
          scrollCacheKey={`canvas:${card.id}`}
        />
      </Suspense>
    </div>
  )
}
