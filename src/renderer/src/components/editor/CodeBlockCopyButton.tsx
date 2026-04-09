import React, { useCallback, useState } from 'react'
import { Copy, Check } from 'lucide-react'

type CodeBlockCopyButtonProps = React.HTMLAttributes<HTMLPreElement> & {
  children?: React.ReactNode
}

export default function CodeBlockCopyButton({
  children,
  ...props
}: CodeBlockCopyButtonProps): React.JSX.Element {
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(() => {
    // Extract the text content from the nested <code> element rendered by
    // react-markdown inside <pre>. We walk the React children tree to grab the
    // raw string so clipboard receives plain text, not markup.
    let text = ''
    React.Children.forEach(children, (child) => {
      if (React.isValidElement(child) && child.props) {
        const inner = (child.props as { children?: React.ReactNode }).children
        text += typeof inner === 'string' ? inner : extractText(inner)
      } else if (typeof child === 'string') {
        text += child
      }
    })

    void window.api.ui
      .writeClipboardText(text)
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      })
      .catch(() => {
        // Silently swallow clipboard write failures (e.g. permission denied).
      })
  }, [children])

  return (
    <div className="code-block-wrapper">
      <pre {...props}>{children}</pre>
      <button
        type="button"
        className="code-block-copy-btn"
        onClick={handleCopy}
        aria-label="Copy code"
        title="Copy code"
      >
        {copied ? (
          <>
            <Check size={14} />
            <span className="code-block-copy-label">Copied</span>
          </>
        ) : (
          <Copy size={14} />
        )}
      </button>
    </div>
  )
}

/** Recursively extract text from React children. */
function extractText(node: React.ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node)
  }
  if (Array.isArray(node)) {
    return node.map(extractText).join('')
  }
  if (React.isValidElement(node) && node.props) {
    return extractText((node.props as { children?: React.ReactNode }).children)
  }
  return ''
}
