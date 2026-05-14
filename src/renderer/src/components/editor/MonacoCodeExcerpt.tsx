import React, { useEffect, useMemo, useState } from 'react'
import { monaco } from '@/lib/monaco-setup'
import { computeEditorFontSize } from '@/lib/editor-font-zoom'
import { resolveDocumentTheme } from '@/lib/document-theme'
import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'

let pythonLanguageRegistrationPromise: Promise<void> | null = null

async function ensureColorizationLanguage(language: string): Promise<void> {
  if (language !== 'python') {
    return
  }
  pythonLanguageRegistrationPromise ??=
    import('monaco-editor/esm/vs/basic-languages/python/python.js').then(
      ({ conf, language: pythonTokens }) => {
        // Why: notebook excerpts colorize without mounting Monaco editors. Load
        // Python tokens only on demand so non-notebook users do not pay at startup.
        if (!monaco.languages.getLanguages().some((item) => item.id === 'python')) {
          monaco.languages.register({
            id: 'python',
            extensions: ['.py', '.pyw'],
            aliases: ['Python', 'py']
          })
        }
        monaco.languages.setLanguageConfiguration('python', conf)
        monaco.languages.setMonarchTokensProvider('python', pythonTokens)
      }
    )
  await pythonLanguageRegistrationPromise
}

type MonacoCodeExcerptProps = {
  lines: string[]
  firstLineNumber: number
  highlightedStartLine: number
  highlightedEndLine: number
  language: string
}

export default function MonacoCodeExcerpt({
  lines,
  firstLineNumber,
  highlightedStartLine,
  highlightedEndLine,
  language
}: MonacoCodeExcerptProps): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const editorFontZoomLevel = useAppStore((s) => s.editorFontZoomLevel)
  const editorFontSize = computeEditorFontSize(
    settings?.terminalFontSize ?? 13,
    editorFontZoomLevel
  )
  const fontFamily = settings?.terminalFontFamily || 'monospace'
  const isDark = resolveDocumentTheme(settings?.theme ?? 'system')
  const code = useMemo(() => lines.join('\n'), [lines])
  const [htmlLines, setHtmlLines] = useState<string[]>(() => lines.map(() => ''))

  useEffect(() => {
    monaco.editor.setTheme(isDark ? 'vs-dark' : 'vs')
  }, [isDark])

  useEffect(() => {
    if (lines.length === 0) {
      setHtmlLines([])
      return
    }

    let cancelled = false
    // Why: notebook languages like Python are loaded lazily by Monaco. The
    // async colorizer waits for that tokenizer; colorizeModelLine can render
    // only default-token spans if called before the contribution finishes.
    void ensureColorizationLanguage(language)
      .catch(() => undefined)
      .then(() => monaco.editor.colorize(code, language, { tabSize: 2 }))
      .then((html) => {
        if (cancelled) {
          return
        }
        const nextLines = html.split('<br/>').slice(0, lines.length)
        setHtmlLines(nextLines)
      })

    return () => {
      cancelled = true
    }
  }, [code, language, lines])

  return (
    <div
      className="overflow-x-auto py-1 text-[12px] leading-5"
      style={{ fontFamily, fontSize: editorFontSize }}
    >
      {lines.map((codeLine, index) => {
        const lineNumber = firstLineNumber + index
        const isCommentedLine =
          lineNumber >= highlightedStartLine && lineNumber <= highlightedEndLine
        const html = htmlLines[index] || (codeLine ? undefined : '&nbsp;')
        return (
          <div
            key={lineNumber}
            className={cn('flex font-mono', isCommentedLine && 'bg-emerald-500/10')}
          >
            <span className="w-12 shrink-0 select-none border-r border-border/40 px-2 text-right text-muted-foreground tabular-nums">
              {lineNumber}
            </span>
            {html ? (
              <code
                className="min-w-max flex-1 whitespace-pre px-3 text-foreground"
                dangerouslySetInnerHTML={{ __html: html }}
              />
            ) : (
              <code className="min-w-max flex-1 whitespace-pre px-3 text-foreground">
                {codeLine || ' '}
              </code>
            )}
          </div>
        )
      })}
    </div>
  )
}
