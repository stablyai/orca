import React from 'react'
import CommentMermaidBlock from './CommentMermaidBlock'

// Why: react-markdown sets className="language-mermaid" on the <code> inside a
// fenced ```mermaid block. Detecting it lets us render a real diagram instead of
// the raw source, matching the editor's markdown preview.
export function isMermaidFence(className: string | undefined): boolean {
  return /\blanguage-mermaid\b/.test(className ?? '')
}

export function renderMermaidFence(
  children: React.ReactNode,
  className?: string
): React.JSX.Element {
  return <CommentMermaidBlock content={String(children).trimEnd()} className={className} />
}

// Why: MermaidBlock renders a <div> via innerHTML, which is invalid inside a
// <pre>. The <pre> renderer receives the inner <code> element (not the rendered
// diagram), so detect the mermaid fence from that child's className and unwrap.
export function isMermaidPre(children: React.ReactNode): boolean {
  const child = React.Children.toArray(children)[0]
  if (!React.isValidElement(child)) {
    return false
  }
  const className = (child.props as { className?: string } | null)?.className
  return isMermaidFence(className)
}
