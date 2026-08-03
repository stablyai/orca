import React from 'react'
import { cn } from '@/lib/utils'

export type CommentMarkdownFilePathSpans = {
  /** Whether a whole inline-code span should render as an openable file path. */
  isFilePath: (text: string) => boolean
  onOpen: (event: React.MouseEvent<HTMLElement>, pathText: string) => void
}

// react-markdown routes both inline spans and the <code> inside a fence through
// the same `code` component, and `className` is set only when a fence declares a
// language — so bare ``` blocks are indistinguishable there. The <pre> renderer
// marks its subtree instead, and the code renderer reads the mark.
const FencedCodeContext = React.createContext(false)
const LinkedCodeContext = React.createContext(false)

export function FencedCodeBoundary({
  children
}: {
  children: React.ReactNode
}): React.ReactElement {
  return <FencedCodeContext.Provider value={true}>{children}</FencedCodeContext.Provider>
}

export function useIsFencedCode(): boolean {
  return React.useContext(FencedCodeContext)
}

export function LinkedCodeBoundary({
  children
}: {
  children: React.ReactNode
}): React.ReactElement {
  return <LinkedCodeContext.Provider value={true}>{children}</LinkedCodeContext.Provider>
}

export function useIsLinkedCode(): boolean {
  return React.useContext(LinkedCodeContext)
}

/**
 * The span's text when it is a single plain string. Richer children mean the
 * span carries markup, which a bare path never does.
 */
export function readCodeSpanText(children: React.ReactNode): string | null {
  if (typeof children === 'string') {
    return children
  }
  if (Array.isArray(children) && children.length === 1 && typeof children[0] === 'string') {
    return children[0]
  }
  return null
}

export function FilePathCodeSpan({
  pathText,
  codeClassName,
  spans,
  children
}: {
  pathText: string
  codeClassName: string
  spans: CommentMarkdownFilePathSpans
  children: React.ReactNode
}): React.ReactElement {
  return (
    <button
      type="button"
      // A real button (not a <code onClick>) so the path is reachable and
      // activatable by keyboard, matching NativeChatToolRun's affordance.
      className="max-w-full rounded align-baseline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      title={pathText}
      onClick={(event) => {
        event.stopPropagation()
        spans.onOpen(event, pathText)
      }}
    >
      <code
        className={cn(
          codeClassName,
          // File paths read as a distinct destination from web links: same
          // accent, monospace, no underline.
          'text-primary transition-colors hover:text-primary/80'
        )}
      >
        {children}
      </code>
    </button>
  )
}
