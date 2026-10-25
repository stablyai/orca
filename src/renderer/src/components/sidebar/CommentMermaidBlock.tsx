import React from 'react'
import MermaidBlock, { type RenderedMermaidDiagram } from '@/components/editor/MermaidBlock'
import { useAppStore } from '@/store'
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
  const openModal = useAppStore((s) => s.openModal)
  const expand = (diagram: RenderedMermaidDiagram): void => openModal('diagram-viewer', diagram)

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
