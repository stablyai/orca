import React, { useCallback, useRef, useState } from 'react'
import { NodeViewContent, NodeViewWrapper } from '@tiptap/react'
import type { NodeViewProps } from '@tiptap/react'
import { Copy, Check } from 'lucide-react'
import { useAppStore } from '@/store'
import MermaidBlock from './MermaidBlock'
import { translate } from '@/i18n/i18n'

/**
 * Common languages shown in the selector. The user can also type a language
 * name directly in the markdown fence (```rust) and it will be preserved —
 * this list is just for quick picking in the UI.
 */
const LANGUAGES = [
  {
    value: '',
    label: translate('auto.components.editor.RichMarkdownCodeBlock.13822cdfda', 'Plain text')
  },
  {
    value: 'bash',
    label: translate('auto.components.editor.RichMarkdownCodeBlock.4227cf50fe', 'Bash')
  },
  { value: 'c', label: 'C' },
  {
    value: 'cpp',
    label: translate('auto.components.editor.RichMarkdownCodeBlock.4daed43ae3', 'C++')
  },
  {
    value: 'css',
    label: translate('auto.components.editor.RichMarkdownCodeBlock.026653f21f', 'CSS')
  },
  {
    value: 'diff',
    label: translate('auto.components.editor.RichMarkdownCodeBlock.bf6ee5caaa', 'Diff')
  },
  {
    value: 'go',
    label: translate('auto.components.editor.RichMarkdownCodeBlock.edfcc64182', 'Go')
  },
  {
    value: 'graphql',
    label: translate('auto.components.editor.RichMarkdownCodeBlock.706fd85738', 'GraphQL')
  },
  {
    value: 'html',
    label: translate('auto.components.editor.RichMarkdownCodeBlock.8c4a3fa02d', 'HTML')
  },
  {
    value: 'java',
    label: translate('auto.components.editor.RichMarkdownCodeBlock.36536ad539', 'Java')
  },
  {
    value: 'javascript',
    label: translate('auto.components.editor.RichMarkdownCodeBlock.a209c57063', 'JavaScript')
  },
  {
    value: 'json',
    label: translate('auto.components.editor.RichMarkdownCodeBlock.78eba32de4', 'JSON')
  },
  {
    value: 'kotlin',
    label: translate('auto.components.editor.RichMarkdownCodeBlock.bcb236e2d8', 'Kotlin')
  },
  {
    value: 'markdown',
    label: translate('auto.components.editor.RichMarkdownCodeBlock.983b9576b4', 'Markdown')
  },
  {
    value: 'mermaid',
    label: translate('auto.components.editor.RichMarkdownCodeBlock.89d6cc14fb', 'Mermaid')
  },
  {
    value: 'python',
    label: translate('auto.components.editor.RichMarkdownCodeBlock.2391f9cda9', 'Python')
  },
  {
    value: 'ruby',
    label: translate('auto.components.editor.RichMarkdownCodeBlock.96182a2f64', 'Ruby')
  },
  {
    value: 'rust',
    label: translate('auto.components.editor.RichMarkdownCodeBlock.e72e6b03f4', 'Rust')
  },
  {
    value: 'scss',
    label: translate('auto.components.editor.RichMarkdownCodeBlock.5af8251002', 'SCSS')
  },
  {
    value: 'shell',
    label: translate('auto.components.editor.RichMarkdownCodeBlock.d01f55be57', 'Shell')
  },
  {
    value: 'sql',
    label: translate('auto.components.editor.RichMarkdownCodeBlock.3009f722b9', 'SQL')
  },
  {
    value: 'swift',
    label: translate('auto.components.editor.RichMarkdownCodeBlock.9e384d48dc', 'Swift')
  },
  {
    value: 'typescript',
    label: translate('auto.components.editor.RichMarkdownCodeBlock.88d777bc07', 'TypeScript')
  },
  {
    value: 'xml',
    label: translate('auto.components.editor.RichMarkdownCodeBlock.5ef5605cb7', 'XML')
  },
  {
    value: 'yaml',
    label: translate('auto.components.editor.RichMarkdownCodeBlock.74eab1d9b2', 'YAML')
  }
]

export function RichMarkdownCodeBlock({
  node,
  updateAttributes
}: NodeViewProps): React.JSX.Element {
  const language = (node.attrs.language as string) || ''
  const [copied, setCopied] = useState(false)
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
      >
        {LANGUAGES.map((lang) => (
          <option key={lang.value} value={lang.value}>
            {lang.label}
          </option>
        ))}
        {/* If the document has a language not in our list, show it as-is */}
        {language && !LANGUAGES.some((l) => l.value === language) ? (
          <option value={language}>{language}</option>
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
