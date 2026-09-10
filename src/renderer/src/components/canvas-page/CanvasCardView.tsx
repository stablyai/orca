import { useCallback, useState } from 'react'
import { NodeResizer, type Node, type NodeProps } from '@xyflow/react'
import { ExternalLink, FileText, Globe, RotateCw, X } from 'lucide-react'
import type { CanvasCard } from '@/store/slices/canvas'
import { CANVAS_MIN_CARD_HEIGHT, CANVAS_MIN_CARD_WIDTH } from '@/store/slices/canvas'
import { useAppStore } from '@/store'
import { basename, getRelativePathInsideRoot } from '@/lib/path'
import { detectLanguage } from '@/lib/language-detect'
import { openFileInBrowserTab } from '@/lib/file-preview'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { CanvasMarkdownCard } from './canvas-markdown-card'
import { CanvasHtmlCard } from './canvas-html-card'

export type CanvasFlowNode = Node<{ card: CanvasCard }, 'canvasCard'>

export function CanvasCardNode({ data, selected }: NodeProps<CanvasFlowNode>): React.JSX.Element {
  const { card } = data
  const removeCanvasCard = useAppStore((s) => s.removeCanvasCard)
  const [reloadSignal, setReloadSignal] = useState(0)

  const openInTab = useCallback(() => {
    const state = useAppStore.getState()
    if (card.kind === 'html') {
      openFileInBrowserTab({ filePath: card.filePath, worktreeId: card.worktreeId })
    } else {
      const worktreeRoot = state.getKnownWorktreeById(card.worktreeId)?.path ?? null
      state.openFile({
        filePath: card.filePath,
        relativePath:
          getRelativePathInsideRoot(card.filePath, worktreeRoot) ?? basename(card.filePath),
        worktreeId: card.worktreeId,
        language: detectLanguage(card.filePath),
        mode: 'markdown-preview'
      })
    }
    // Why: the new tab lives on the workspace surface, so leaving the canvas is the opening.
    state.closeCanvasPage()
  }, [card.filePath, card.kind, card.worktreeId])

  const KindIcon = card.kind === 'html' ? Globe : FileText

  return (
    <div
      className={cn(
        'flex h-full w-full flex-col overflow-hidden rounded-lg border bg-card shadow-md',
        selected ? 'border-primary' : 'border-border'
      )}
    >
      <NodeResizer
        isVisible={selected}
        minWidth={CANVAS_MIN_CARD_WIDTH}
        minHeight={CANVAS_MIN_CARD_HEIGHT}
      />
      {/* Why .canvas-card-header: the node's dragHandle, so only the chrome moves the card. */}
      <div className="canvas-card-header flex h-8 shrink-0 cursor-grab select-none items-center gap-1.5 border-b border-border/60 bg-muted/40 px-2 active:cursor-grabbing">
        <KindIcon className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.75} />
        <span className="min-w-0 flex-1 truncate text-xs font-medium" title={card.filePath}>
          {basename(card.filePath)}
        </span>
        {/* Why nodrag: a button press must click, not start a node drag. */}
        <div className="nodrag flex items-center">
          {card.kind === 'html' ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={translate('auto.components.canvas-page.reloadCard', 'Reload preview')}
              onClick={() => setReloadSignal((count) => count + 1)}
            >
              <RotateCw className="size-3.5" />
            </Button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={translate('auto.components.canvas-page.openInTab', 'Open in a tab')}
            onClick={openInTab}
          >
            <ExternalLink className="size-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={translate('auto.components.canvas-page.removeCard', 'Remove from canvas')}
            onClick={() => removeCanvasCard(card.worktreeId, card.id)}
          >
            <X className="size-3.5" />
          </Button>
        </div>
      </div>
      {/* Why nowheel: wheel over card content scrolls the document, not the canvas zoom. */}
      <div
        className={cn(
          'nodrag nowheel min-h-0 flex-1',
          card.kind === 'markdown' && 'bg-editor-surface'
        )}
      >
        {card.kind === 'html' ? (
          <CanvasHtmlCard card={card} reloadSignal={reloadSignal} />
        ) : (
          <CanvasMarkdownCard card={card} />
        )}
      </div>
    </div>
  )
}
