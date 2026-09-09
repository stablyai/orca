import React, { useCallback, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { NodeViewContent, NodeViewWrapper } from '@tiptap/react'
import type { NodeViewProps } from '@tiptap/react'
import { Copy, Check } from 'lucide-react'
import { useAppStore } from '@/store'
import MermaidBlock from './MermaidBlock'
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
  // Why: ProseMirror renders every node view in the document, so eagerly
  // mounting the full language list cost ~25 <option> elements per code block —
  // in a large document that dwarfs the prose DOM and slows every keystroke.
  const [languageListMounted, setLanguageListMounted] = useState(false)
  const copiedResetTimerRef = useRef<number | null>(null)
  // Why: clipboard IPC can resolve after the node view unmounts; avoid
  // starting a reset timer that will outlive the component.
  const isMountedRef = useRef(false)
  const settings = useAppStore((s) => s.settings)
  const isDark =
    settings?.theme === 'dark' ||
    (settings?.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)

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
    // Why: the native popup opens as this same discrete event's default action,
    // so the list must be in the DOM before React's normal flush would land.
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
          // Silently swallow clipboard write failures (e.g. permission denied).
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
          // Why: a closed <select> only paints its selected option, so until the
          // user reaches for the list one entry renders the same visible label.
          <option value={language}>{getCodeBlockLanguageLabel(language)}</option>
        )}
        {/* If the document has a language not in our list, show it as-is */}
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
      {/* Why: mermaid diagrams render as a live SVG preview below the editable
          source so users can see the result while editing. The code block stays
          editable — the diagram is read-only output. This preview also goes
          through MermaidBlock's sanitized SVG path, so it must opt out of
          Mermaid HTML labels just like markdown preview to keep labels visible. */}
      {isMermaid && node.textContent.trim() && (
        <div contentEditable={false} className="mermaid-preview">
          <MermaidBlock content={node.textContent.trim()} isDark={isDark} htmlLabels={false} />
        </div>
      )}
    </NodeViewWrapper>
  )
}
