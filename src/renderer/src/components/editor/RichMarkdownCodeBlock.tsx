import React, { useCallback, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { NodeViewContent, NodeViewWrapper } from '@tiptap/react'
import type { NodeViewProps } from '@tiptap/react'
import { Copy, Check } from 'lucide-react'
import MermaidBlock from './MermaidBlock'
import { useDocumentDarkTheme } from '@/hooks/use-document-dark-theme'
import { translate } from '@/i18n/i18n'
import {
  getCodeBlockLanguageLabel,
  getCodeBlockLanguages,
  isKnownCodeBlockLanguage
} from './rich-markdown-code-block-languages'

export function RichMarkdownCodeBlock({
  node,
  updateAttributes
}: NodeViewProps): React.JSX.Element {
  useTranslation()
  const language = (node.attrs.language as string) || ''
  const [copied, setCopied] = useState(false)
  // ProseMirror mounts every node view; defer full language options so large documents avoid per-block DOM cost on each keystroke.
  const [languageListMounted, setLanguageListMounted] = useState(false)
  const copiedResetTimerRef = useRef<number | null>(null)
  // Clipboard IPC may settle after unmount; do not start an orphan reset timer.
  const isMountedRef = useRef(false)
  const isDark = useDocumentDarkTheme()

  const isMermaid = language === 'mermaid'

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

  const mountLanguageList = useCallback(() => {
    if (languageListMounted) {
      return
    }
    // Populate before the native popup’s default action; React’s normal flush would arrive too late.
    flushSync(() => setLanguageListMounted(true))
  }, [languageListMounted])

  const onChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      updateAttributes({ language: e.target.value })
    },
    [updateAttributes]
  )

  const handleCopy = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      const text = node.textContent
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
          // Clipboard permission failures must not disrupt editing.
        })
    },
    [clearCopiedResetTimer, node]
  )

  return (
    <NodeViewWrapper className="rich-markdown-code-block-wrapper">
      <select
        className="rich-markdown-code-block-lang"
        contentEditable={false}
        value={language}
        onChange={onChange}
        onMouseDown={mountLanguageList}
        onFocus={mountLanguageList}
      >
        {languageListMounted ? (
          getCodeBlockLanguages().map((lang) => (
            <option key={lang.value} value={lang.value}>
              {lang.label}
            </option>
          ))
        ) : (
          // Closed selects need only their selected option until the user requests the list.
          <option value={language}>{getCodeBlockLanguageLabel(language)}</option>
        )}
        {/* Preserve document languages absent from the built-in list. */}
        {languageListMounted && language && !isKnownCodeBlockLanguage(language) ? (
          <option key={language} value={language}>
            {language}
          </option>
        ) : null}
      </select>
      <button
        ref={setCopyButtonRef}
        type="button"
        className="code-block-copy-btn"
        contentEditable={false}
        onClick={handleCopy}
        aria-label={translate(
          'auto.components.editor.RichMarkdownCodeBlock.c72beafc0f',
          'Copy code'
        )}
        title={translate('auto.components.editor.RichMarkdownCodeBlock.c72beafc0f', 'Copy code')}
      >
        {copied ? (
          <>
            <Check size={14} />
            <span className="code-block-copy-label">
              {translate('auto.components.editor.RichMarkdownCodeBlock.232d9ed853', 'Copied')}
            </span>
          </>
        ) : (
          <Copy size={14} />
        )}
      </button>
      <NodeViewContent<'pre'> as="pre" />
      {/* Keep Mermaid source editable; native SVG labels survive the preview’s sanitization. */}
      {isMermaid && node.textContent.trim() && (
        <div contentEditable={false} className="mermaid-preview">
          <MermaidBlock content={node.textContent.trim()} isDark={isDark} htmlLabels={false} />
        </div>
      )}
    </NodeViewWrapper>
  )
}
