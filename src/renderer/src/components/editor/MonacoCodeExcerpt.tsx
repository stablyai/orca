import React, { useEffect, useMemo, useState } from 'react'
import { monaco } from '@/lib/monaco-setup'
import { EDITOR_TYPOGRAPHY_SURFACE_CLASS, editorTypographyTextStyle } from '@/lib/editor-typography'
import { useEditorTypography } from '@/hooks/use-editor-typography'
import { cn } from '@/lib/utils'
import { useMonacoTheme } from '@/hooks/use-monaco-theme'

let pythonLanguageRegistrationPromise: Promise<void> | null = null

async function ensureColorizationLanguage(language: string): Promise<void> {
  if (language !== 'python') {
    return
  }
  pythonLanguageRegistrationPromise ??=
    import('monaco-editor/esm/vs/basic-languages/python/python.js').then(
      ({ conf, language: pythonTokens }) => {
        // Load Python tokens only for notebook excerpts so other users pay no startup cost.
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

/** Monaco token HTML per line; loads lazy tokenizers (e.g. Python) before colorizing. */
export function useMonacoColorizedLines(lines: string[], language: string): string[] {
  const monacoTheme = useMonacoTheme()
  const code = useMemo(() => lines.join('\n'), [lines])
  const lineCount = lines.length
  const [htmlLines, setHtmlLines] = useState<string[]>(() => lines.map(() => ''))

  useEffect(() => {
    monaco.editor.setTheme(monacoTheme)
  }, [monacoTheme])

  // Why: colorize emits theme-specific token classes, so a theme switch must re-colorize.
  useEffect(() => {
    if (lineCount === 0) {
      setHtmlLines([])
      return
    }

    let cancelled = false
    // Wait for lazy tokenizers before colorizing; colorizeModelLine would emit default tokens while contributions load.
    void ensureColorizationLanguage(language)
      .catch(() => undefined)
      .then(async () => {
        if (cancelled) {
          return
        }
        const html = await monaco.editor.colorize(code, language, { tabSize: 2 })
        if (cancelled) {
          return
        }
        const nextLines = html.split('<br/>').slice(0, lineCount)
        setHtmlLines(nextLines)
      })

    return () => {
      cancelled = true
    }
  }, [code, language, lineCount, monacoTheme])

  return htmlLines
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
  const typography = useEditorTypography()
  const htmlLines = useMonacoColorizedLines(lines, language)

  return (
    <div
      className={cn(
        'code-editor-colors overflow-x-auto py-1 text-[12px] leading-5',
        EDITOR_TYPOGRAPHY_SURFACE_CLASS
      )}
      style={editorTypographyTextStyle(typography)}
    >
      {lines.map((codeLine, index) => {
        const lineNumber = firstLineNumber + index
        const isCommentedLine =
          lineNumber >= highlightedStartLine && lineNumber <= highlightedEndLine
        const html = htmlLines[index] || (codeLine ? undefined : '&nbsp;')
        return (
          <div key={lineNumber} className={cn('flex', isCommentedLine && 'bg-ring/15')}>
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
