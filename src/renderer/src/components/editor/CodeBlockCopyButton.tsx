import React, { useCallback, useRef, useState } from 'react'
import { Copy, Check } from 'lucide-react'
import { translate } from '@/i18n/i18n'

type CodeBlockCopyButtonProps = React.HTMLAttributes<HTMLPreElement> & {
  children?: React.ReactNode
}

export default function CodeBlockCopyButton({
  children,
  ...props
}: CodeBlockCopyButtonProps): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const copiedResetTimerRef = useRef<number | null>(null)
  // Clipboard IPC may settle after unmount; do not start an orphan reset timer.
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
    // Extract raw text from react-markdown’s nested code children so the clipboard receives no markup.
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
        // Clipboard permission failures must not disrupt the preview.
      })
  }, [children, clearCopiedResetTimer])

  return (
    <div className="code-block-wrapper">
      <pre {...props}>{children}</pre>
      <button
        ref={setCopyButtonRef}
        type="button"
        className="code-block-copy-btn"
        onClick={handleCopy}
        aria-label={translate('auto.components.editor.CodeBlockCopyButton.1f9f4def45', 'Copy code')}
        title={translate('auto.components.editor.CodeBlockCopyButton.1f9f4def45', 'Copy code')}
      >
        {copied ? (
          <>
            <Check size={14} />
            <span className="code-block-copy-label">
              {translate('auto.components.editor.CodeBlockCopyButton.28921f5bf9', 'Copied')}
            </span>
          </>
        ) : (
          <Copy size={14} />
        )}
      </button>
    </div>
  )
}

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
