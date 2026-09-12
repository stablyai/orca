import React, { useEffect, useMemo, useRef, useState } from 'react'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { installEditorSaveShortcut } from './editor-shortcuts'
import {
  getMermaidTextDiagramModeOptions,
  isMermaidTextDiagramMode,
  type MermaidTextDiagramMode
} from './mermaid-text-diagram-view-modes'
import MermaidBlock from './MermaidBlock'
import { useDebouncedMermaidDiagramContent } from './use-debounced-mermaid-diagram-content'
import ZoomableDiagramSurface from './ZoomableDiagramSurface'

type MermaidViewerProps = {
  content: string
  filePath: string
  onContentChange?: (content: string) => void
  onSave?: (content: string) => void | Promise<boolean>
  readOnly?: boolean
}

export default function MermaidViewer({
  content,
  filePath,
  onContentChange,
  onSave,
  readOnly = false
}: MermaidViewerProps): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const latestContentRef = useRef(content)
  const lastEmittedContentRef = useRef(content)
  const [mode, setMode] = useState<MermaidTextDiagramMode>('chart')
  const [draftContent, setDraftContent] = useState(content)
  const [syncedFilePath, setSyncedFilePath] = useState(filePath)
  const [syncedContent, setSyncedContent] = useState(content)
  const settings = useAppStore((s) => s.settings)
  const isDark =
    settings?.theme === 'dark' ||
    (settings?.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)

  // File switch: immediate sync so debounce hook flushes. Same-file: only accept
  // content that differs from what we last emitted (external reload, not echo).
  if (syncedFilePath !== filePath) {
    setSyncedFilePath(filePath)
    setSyncedContent(content)
    setDraftContent(content)
    lastEmittedContentRef.current = content
    latestContentRef.current = content
  } else if (content !== syncedContent) {
    setSyncedContent(content)
    if (content !== lastEmittedContentRef.current) {
      setDraftContent(content)
      lastEmittedContentRef.current = content
      latestContentRef.current = content
    }
  }

  const filename = useMemo(() => filePath.split(/[/\\]/).pop() || filePath, [filePath])
  const trimmedContent = useMemo(() => draftContent.trim(), [draftContent])
  const renderContent = useDebouncedMermaidDiagramContent(trimmedContent, filePath)
  const viewOptions = getMermaidTextDiagramModeOptions('auto.components.editor.MermaidViewer')
  const showSource = mode !== 'chart' || trimmedContent.length === 0
  const showDiagram = mode !== 'code' && trimmedContent.length > 0
  const sourceLabel = translate('auto.components.editor.MermaidViewer.source', 'Mermaid source')
  const sourcePlaceholder = translate(
    'auto.components.editor.MermaidViewer.sourcePlaceholder',
    'Type Mermaid source...'
  )

  useEffect(() => {
    latestContentRef.current = draftContent
  }, [draftContent])

  useEffect(() => {
    const root = rootRef.current
    if (!root || !onSave || readOnly) {
      return
    }

    return installEditorSaveShortcut(root, () => {
      void onSave(latestContentRef.current)
    })
  }, [onSave, readOnly])

  const handleSourceChange = (event: React.ChangeEvent<HTMLTextAreaElement>): void => {
    const nextContent = event.currentTarget.value
    if (mode === 'chart' && trimmedContent.length === 0 && nextContent.trim().length > 0) {
      setMode('split')
    }
    setDraftContent(nextContent)
    lastEmittedContentRef.current = nextContent
    onContentChange?.(nextContent)
  }

  return (
    <div ref={rootRef} className="mermaid-viewer h-full min-h-0">
      <div className="mermaid-text-diagram-toolbar">
        <div className="mermaid-text-diagram-title" title={filename}>
          {filename}
        </div>
        <ToggleGroup
          type="single"
          size="sm"
          variant="outline"
          spacing={0}
          value={mode}
          onValueChange={(nextMode) => {
            if (isMermaidTextDiagramMode(nextMode)) {
              setMode(nextMode)
            }
          }}
        >
          {viewOptions.map((option) => (
            <ToggleGroupItem key={option.value} value={option.value}>
              {option.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
      <div className={cn('mermaid-text-diagram-body', `is-${mode}`)}>
        {showSource ? (
          <textarea
            className="mermaid-text-diagram-source mermaid-text-diagram-source-editor scrollbar-editor"
            value={draftContent}
            readOnly={readOnly || !onContentChange}
            spellCheck={false}
            wrap="off"
            aria-label={sourceLabel}
            placeholder={sourcePlaceholder}
            onChange={handleSourceChange}
          />
        ) : null}
        {showDiagram ? (
          <ZoomableDiagramSurface
            className="mermaid-text-diagram-chart"
            diagramKey={renderContent}
            resetKey={filePath}
            label={translate('auto.components.editor.MermaidViewer.mermaid', 'Mermaid')}
          >
            <MermaidBlock content={renderContent} isDark={isDark} htmlLabels={false} />
          </ZoomableDiagramSurface>
        ) : null}
      </div>
    </div>
  )
}
