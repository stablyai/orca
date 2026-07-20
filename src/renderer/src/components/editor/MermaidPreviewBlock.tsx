import { Maximize2 } from 'lucide-react'
import { useState, type JSX } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { translate } from '@/i18n/i18n'
import MermaidBlock from './MermaidBlock'

type MermaidPreviewBlockProps = {
  content: string
  isDark: boolean
  htmlLabels?: boolean
}

export default function MermaidPreviewBlock({
  content,
  isDark,
  htmlLabels
}: MermaidPreviewBlockProps): JSX.Element {
  const [isOpen, setIsOpen] = useState(false)
  const openLabel = translate(
    'auto.components.editor.MermaidPreviewBlock.98c6dc1f8b',
    'Open full size'
  )

  return (
    <>
      <div className="mermaid-preview-wrapper">
        <MermaidBlock content={content} isDark={isDark} htmlLabels={htmlLabels} />
        <button
          type="button"
          className="mermaid-preview-expand-btn"
          aria-label={openLabel}
          title={openLabel}
          onClick={() => setIsOpen(true)}
        >
          <Maximize2 size={14} />
        </button>
      </div>
      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogContent className="top-1/2 left-1/2 flex h-[80vh] w-[85vw] max-w-[85vw] -translate-x-1/2 -translate-y-1/2 flex-col gap-0 overflow-hidden border border-border/60 bg-background p-0 shadow-2xl sm:max-w-[85vw]">
          <DialogTitle className="sr-only">{openLabel}</DialogTitle>
          <DialogDescription className="sr-only">
            {translate(
              'auto.components.editor.MermaidPreviewBlock.907bf1c86a',
              'Full-size Mermaid diagram preview'
            )}
          </DialogDescription>
          <div className="min-h-0 flex-1 overflow-auto bg-muted/20 scrollbar-editor">
            <div className="mermaid-viewer-canvas">
              <MermaidBlock content={content} isDark={isDark} htmlLabels={htmlLabels} />
            </div>
          </div>
          <div className="flex shrink-0 items-center justify-between border-t border-border/60 bg-background/95 px-3 py-2 text-xs text-muted-foreground">
            <div>
              {translate(
                'auto.components.editor.MermaidPreviewBlock.3c6c89f5fb',
                'Press Esc to close'
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
