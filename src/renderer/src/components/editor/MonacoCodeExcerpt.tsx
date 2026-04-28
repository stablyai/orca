import React, { useEffect, useMemo, useState } from 'react'
import { monaco } from '@/lib/monaco-setup'
import { computeEditorFontSize } from '@/lib/editor-font-zoom'
import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'

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
  const isDark =
    settings?.theme === 'dark' ||
    (settings?.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
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

    // Why: colorizeModelLine gives the comment excerpt Monaco's token colors
    // without mounting a full editor instance for every visible PR comment.
    const model = monaco.editor.createModel(code, language)
    const nextLines = lines.map((_, index) => monaco.editor.colorizeModelLine(model, index + 1, 2))
    model.dispose()
    setHtmlLines(nextLines)
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
