import React, { useCallback, useRef, useState } from 'react'
import { Copy, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'

type CodeBlockCopyButtonProps = React.HTMLAttributes<HTMLPreElement> & {
  children?: React.ReactNode
  /** Fenced-code language shown as a label; omitted for plain fences. */
  language?: string | null
}

export default function CodeBlockCopyButton({
  children,
  language,
  ...props
}: CodeBlockCopyButtonProps): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const copiedResetTimerRef = useRef<number | null>(null)
  // Why: clipboard IPC can resolve after this button unmounts; avoid starting
  // a reset timer that will outlive the component.
  const isMountedRef = useRef(false)

  const clearCopiedResetTimer = useCallback((): void => {
    if (copiedResetTimerRef.current !== null) {
      window.clearTimeout(copiedResetTimerRef.current)
      copiedResetTimerRef.current = null
    }
  }, [])

  const setCopyButtonRef = useCallback(
    (node: HTMLButtonElement | null) => {
      isMountedRef.current = node !== null
      if (node === null) {
        clearCopiedResetTimer()
      }
    },
    [clearCopiedResetTimer]
  )

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
        if (!isMountedRef.current) {
          return
        }
        clearCopiedResetTimer()
        setCopied(true)
        copiedResetTimerRef.current = window.setTimeout(() => {
          copiedResetTimerRef.current = null
          setCopied(false)
        }, 1500)
      })
      .catch(() => {
        // Silently swallow clipboard write failures (e.g. permission denied).
      })
  }, [children, clearCopiedResetTimer])

  return (
    <div className="code-block-wrapper">
      {/* Plain fences (no language) skip the header — they read fine as a bare
          framed block, and the header only earns its space when it labels a language. */}
      {language ? (
        <div className="code-block-header">
          <span className="code-block-language">{language}</span>
          {/* code-block-copy-btn is a functional marker: export scrubbing
              removes the button from PDF/HTML output by that selector. */}
          <Button
            ref={setCopyButtonRef}
            type="button"
            variant="ghost"
            size="xs"
            className="code-block-copy-btn text-muted-foreground"
            onClick={handleCopy}
            aria-label={translate(
              'auto.components.editor.CodeBlockCopyButton.1f9f4def45',
              'Copy code'
            )}
            title={translate('auto.components.editor.CodeBlockCopyButton.1f9f4def45', 'Copy code')}
          >
            {copied ? (
              <>
                <Check />
                {translate('auto.components.editor.CodeBlockCopyButton.28921f5bf9', 'Copied')}
              </>
            ) : (
              <Copy />
            )}
          </Button>
        </div>
      ) : null}
      <pre {...props}>{children}</pre>
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
