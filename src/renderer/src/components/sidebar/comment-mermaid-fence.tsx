import React from 'react'
import CommentMermaidBlock from './CommentMermaidBlock'

// Why: react-markdown sets className="language-mermaid" on the <code> inside a
// fenced ```mermaid block. Detecting it lets us render a real diagram instead of
// the raw source, matching the editor's markdown preview.
export function isMermaidFence(className: string | undefined): boolean {
  return /\blanguage-mermaid\b/.test(className ?? '')
}

// Why: the markdown renderer owns whether the closing fence has arrived. This
// component only receives the fence body, which can already be valid Mermaid
// while the reply is still streaming. Mount the diagram only after close;
// until then keep the source in the tree so the next chunk does not blank it.
function MermaidFenceBlock({
  content,
  className,
  fenceClosed
}: {
  content: string
  className?: string
  fenceClosed: boolean
}): React.JSX.Element {
  if (!fenceClosed) {
    const sourceClassName = className ? `language-mermaid ${className}` : 'language-mermaid'
    return (
      <pre className={sourceClassName}>
        <code>{content}</code>
      </pre>
    )
  }

  return <CommentMermaidBlock content={content} className={className} />
}

export function renderMermaidFence(
  children: React.ReactNode,
  className: string | undefined,
  fenceClosed: boolean
): React.JSX.Element {
  return (
    <MermaidFenceBlock
      content={String(children).trimEnd()}
      className={className}
      fenceClosed={fenceClosed}
    />
  )
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
