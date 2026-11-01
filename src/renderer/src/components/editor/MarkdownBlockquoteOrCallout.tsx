import React from 'react'
import { AlertCircle, AlertTriangle, Flame, Info, Lightbulb } from 'lucide-react'

type CalloutKind = 'note' | 'tip' | 'important' | 'warning' | 'caution'

type ParsedCallout = {
  kind: CalloutKind
  title: string
  content: React.ReactNode[]
}

const CALLOUT_KIND_MAP: Record<string, CalloutKind> = {
  NOTE: 'note',
  INFO: 'note',
  QUOTE: 'note',
  CITE: 'note',
  TIP: 'tip',
  HINT: 'tip',
  IMPORTANT: 'important',
  WARNING: 'warning',
  ATTENTION: 'warning',
  CAUTION: 'caution',
  DANGER: 'caution',
  ERROR: 'caution',
  BUG: 'caution',
  FAIL: 'caution'
}

const DEFAULT_TITLES: Record<CalloutKind, string> = {
  note: 'Note',
  tip: 'Tip',
  important: 'Important',
  warning: 'Warning',
  caution: 'Caution'
}

function getCalloutIcon(kind: CalloutKind): React.ReactElement {
  switch (kind) {
    case 'note':
      return <Info className="markdown-callout-icon" size={16} />
    case 'tip':
      return <Lightbulb className="markdown-callout-icon" size={16} />
    case 'important':
      return <AlertCircle className="markdown-callout-icon" size={16} />
    case 'warning':
      return <AlertTriangle className="markdown-callout-icon" size={16} />
    case 'caution':
      return <Flame className="markdown-callout-icon" size={16} />
  }
}

export function parseCallout(children: React.ReactNode): ParsedCallout | null {
  const childrenArray = React.Children.toArray(children)
  if (childrenArray.length === 0) {
    return null
  }

  const firstChild = childrenArray[0]
  if (
    !React.isValidElement<{ children?: React.ReactNode }>(firstChild) ||
    firstChild.type !== 'p'
  ) {
    return null
  }

  const pChildren = React.Children.toArray(firstChild.props.children)
  if (pChildren.length === 0 || typeof pChildren[0] !== 'string') {
    return null
  }

  const firstText = pChildren[0]
  const match = firstText.match(/^\[!([a-zA-Z]+)\][ \t]*(.*)$/m)
  if (!match) {
    return null
  }

  const rawKind = match[1].toUpperCase()
  const kind = CALLOUT_KIND_MAP[rawKind]
  if (!kind) {
    return null
  }

  const rawTitle = match[2].trim()
  const title = rawTitle || DEFAULT_TITLES[kind]

  // Extract remaining body from the first paragraph
  const newlineIndex = firstText.indexOf('\n')
  const remainingTextInFirst =
    newlineIndex !== -1 ? firstText.slice(newlineIndex + 1).trimStart() : null

  const restPChildren = pChildren.slice(1)
  const newPChildren: React.ReactNode[] = []
  if (remainingTextInFirst) {
    newPChildren.push(remainingTextInFirst)
  }
  newPChildren.push(...restPChildren)

  const content: React.ReactNode[] = []
  if (newPChildren.length > 0) {
    content.push(
      React.cloneElement(firstChild as React.ReactElement<{ children?: React.ReactNode }>, {
        key: 'callout-p0',
        children: newPChildren
      })
    )
  }
  content.push(...childrenArray.slice(1))

  return { kind, title, content }
}

export function MarkdownBlockquoteOrCallout({
  children,
  className,
  ...props
}: React.BlockquoteHTMLAttributes<HTMLQuoteElement>): React.ReactElement {
  const parsed = parseCallout(children)
  if (!parsed) {
    return (
      <blockquote {...props} className={className}>
        {children}
      </blockquote>
    )
  }

  return (
    <div
      role="region"
      aria-label={parsed.title}
      className={`markdown-callout markdown-callout-${parsed.kind} ${className ?? ''}`.trim()}
    >
      <div className="markdown-callout-header">
        {getCalloutIcon(parsed.kind)}
        <span className="markdown-callout-title">{parsed.title}</span>
      </div>
      <div className="markdown-callout-content">{parsed.content}</div>
    </div>
  )
}
