import React from 'react'
import CommentMermaidBlock from './CommentMermaidBlock'

export function isMermaidFence(className: string | undefined): boolean {
  return /\blanguage-mermaid\b/.test(className ?? '')
}

export function renderMermaidFence(
  children: React.ReactNode,
  className?: string,
  pendingContent?: React.ReactNode,
  renderEnabled = true
): React.JSX.Element {
  return (
    <CommentMermaidBlock
      content={String(children).trimEnd()}
      className={className}
      pendingContent={pendingContent}
      renderEnabled={renderEnabled}
    />
  )
}

// Diagrams render divs, invalid inside pre; detect the unrendered code child’s fence class and unwrap.
export function isMermaidPre(children: React.ReactNode): boolean {
  const child = React.Children.toArray(children)[0]
  if (!React.isValidElement(child)) {
    return false
  }
  const className = (child.props as { className?: string } | null)?.className
  return isMermaidFence(className)
}
