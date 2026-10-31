import React from 'react'
import MermaidBlock from '@/components/editor/MermaidBlock'
import { useMermaidDiagramExpand } from '@/components/editor/use-mermaid-diagram-expand'
import { useDocumentDarkTheme } from '@/hooks/use-document-dark-theme'
import { cn } from '@/lib/utils'

// Resolve live document theme here; disable HTML labels because sanitized SVG foreignObjects disappear on some platforms.
export default function CommentMermaidBlock({
  content,
  className,
  pendingContent,
  renderEnabled = true
}: {
  content: string
  className?: string
  pendingContent?: React.ReactNode
  renderEnabled?: boolean
}): React.JSX.Element {
  const isDark = useDocumentDarkTheme()
  const expand = useMermaidDiagramExpand()

  if (pendingContent === undefined) {
    return (
      <div className={cn(className)}>
        <MermaidBlock content={content} isDark={isDark} htmlLabels={false} onExpand={expand} />
      </div>
    )
  }

  return (
    <MermaidBlock
      content={content}
      isDark={isDark}
      htmlLabels={false}
      className={className}
      pendingContent={pendingContent}
      renderEnabled={renderEnabled}
      onExpand={expand}
    />
  )
}
