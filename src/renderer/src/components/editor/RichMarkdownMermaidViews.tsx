import { NodeViewContent } from '@tiptap/react'
import { type JSX, useState } from 'react'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import {
  getMermaidTextDiagramModeOptions,
  isMermaidTextDiagramMode,
  type MermaidTextDiagramMode
} from './mermaid-text-diagram-view-modes'
import MermaidBlock from './MermaidBlock'
import { useDebouncedMermaidDiagramContent } from './use-debounced-mermaid-diagram-content'
import ZoomableDiagramSurface from './ZoomableDiagramSurface'

type RichMarkdownMermaidViewsProps = {
  content: string
  isDark: boolean
}

export default function RichMarkdownMermaidViews({
  content,
  isDark
}: RichMarkdownMermaidViewsProps): JSX.Element {
  const [mode, setMode] = useState<MermaidTextDiagramMode>('split')
  const trimmedContent = content.trim()
  const renderContent = useDebouncedMermaidDiagramContent(trimmedContent)
  const modeOptions = getMermaidTextDiagramModeOptions(
    'auto.components.editor.RichMarkdownMermaidViews'
  )
  const showSource = mode !== 'chart' || trimmedContent.length === 0
  const showDiagram = mode !== 'code' && trimmedContent.length > 0

  return (
    <>
      <ToggleGroup
        type="single"
        size="sm"
        variant="outline"
        spacing={0}
        value={mode}
        className="rich-markdown-mermaid-view-toggle"
        contentEditable={false}
        onValueChange={(nextMode) => {
          if (isMermaidTextDiagramMode(nextMode)) {
            setMode(nextMode)
          }
        }}
      >
        {modeOptions.map((option) => (
          <ToggleGroupItem key={option.value} value={option.value}>
            {option.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <div className={cn('rich-markdown-mermaid-layout', `is-${mode}`)}>
        <NodeViewContent<'pre'>
          as="pre"
          className={cn(!showSource && 'rich-markdown-code-block-source-hidden')}
        />
        {showDiagram ? (
          <div contentEditable={false} className="mermaid-preview">
            <ZoomableDiagramSurface
              diagramKey={renderContent}
              label={translate(
                'auto.components.editor.RichMarkdownMermaidViews.mermaid',
                'Mermaid'
              )}
            >
              <MermaidBlock content={renderContent} isDark={isDark} htmlLabels={false} />
            </ZoomableDiagramSurface>
          </div>
        ) : null}
      </div>
    </>
  )
}
