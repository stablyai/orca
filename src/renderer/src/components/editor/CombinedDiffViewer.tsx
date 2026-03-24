import React, { useState, useEffect, useCallback } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { DiffEditor } from '@monaco-editor/react'
import { useAppStore } from '@/store'
import { detectLanguage } from '@/lib/language-detect'
import '@/lib/monaco-setup'
import { cn } from '@/lib/utils'
import type { GitStatusEntry } from '../../../../shared/types'

type DiffSection = {
  entry: GitStatusEntry
  originalContent: string
  modifiedContent: string
  collapsed: boolean
  loading: boolean
}

export default function CombinedDiffViewer({
  worktreePath
}: {
  worktreePath: string
}): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const isDark =
    settings?.theme === 'dark' ||
    (settings?.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)

  const [sections, setSections] = useState<DiffSection[]>([])
  const [sideBySide, setSideBySide] = useState(true)

  // Load all changed files
  useEffect(() => {
    let cancelled = false

    void (async () => {
      try {
        const entries = (await window.api.git.status({ worktreePath })) as GitStatusEntry[]
        // Filter to only staged and unstaged (not untracked)
        const changed = entries.filter((e) => e.area !== 'untracked')

        if (cancelled) {
          return
        }

        // Initialize sections
        const initialSections: DiffSection[] = changed.map((entry) => ({
          entry,
          originalContent: '',
          modifiedContent: '',
          collapsed: false,
          loading: true
        }))
        setSections(initialSections)

        // Load diffs in parallel
        const results = await Promise.all(
          changed.map(async (entry) => {
            try {
              const diff = (await window.api.git.diff({
                worktreePath,
                filePath: entry.path,
                staged: entry.area === 'staged'
              })) as { originalContent: string; modifiedContent: string }
              return diff
            } catch {
              return { originalContent: '', modifiedContent: '' }
            }
          })
        )

        if (cancelled) {
          return
        }

        setSections((prev) =>
          prev.map((section, i) => ({
            ...section,
            originalContent: results[i].originalContent,
            modifiedContent: results[i].modifiedContent,
            loading: false
          }))
        )
      } catch {
        // ignore
      }
    })()

    return () => {
      cancelled = true
    }
  }, [worktreePath])

  const toggleSection = useCallback((index: number) => {
    setSections((prev) => prev.map((s, i) => (i === index ? { ...s, collapsed: !s.collapsed } : s)))
  }, [])

  if (sections.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        No changes to display
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-border bg-background/50 shrink-0">
        <span className="text-xs text-muted-foreground">{sections.length} changed files</span>
        <div className="flex items-center gap-2">
          <button
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            onClick={() => setSections((prev) => prev.map((s) => ({ ...s, collapsed: true })))}
          >
            Collapse All
          </button>
          <button
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            onClick={() => setSections((prev) => prev.map((s) => ({ ...s, collapsed: false })))}
          >
            Expand All
          </button>
          <button
            className="px-2 py-0.5 text-xs rounded border border-border text-muted-foreground hover:text-foreground transition-colors"
            onClick={() => setSideBySide((prev) => !prev)}
          >
            {sideBySide ? 'Inline' : 'Side by Side'}
          </button>
        </div>
      </div>

      {/* Scrollable diff sections */}
      <div className="flex-1 overflow-auto scrollbar-editor">
        {sections.map((section, index) => {
          const language = detectLanguage(section.entry.path)
          const fileName = section.entry.path.split('/').pop() ?? section.entry.path
          const dirPath = section.entry.path.includes('/')
            ? section.entry.path.slice(0, section.entry.path.lastIndexOf('/'))
            : ''

          return (
            <div
              key={`${section.entry.path}:${section.entry.area}`}
              className="border-b border-border"
            >
              {/* Section header */}
              <button
                className="flex items-center gap-2 w-full px-3 py-2 text-left text-sm hover:bg-accent/30 transition-colors"
                onClick={() => toggleSection(index)}
              >
                {section.collapsed ? (
                  <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                )}
                <span className="font-medium">{fileName}</span>
                {dirPath && <span className="text-muted-foreground text-xs">{dirPath}</span>}
                <span
                  className={cn(
                    'text-xs font-bold ml-auto',
                    section.entry.status === 'modified' && 'text-amber-500',
                    section.entry.status === 'added' && 'text-green-500',
                    section.entry.status === 'deleted' && 'text-red-500'
                  )}
                >
                  {section.entry.area === 'staged' ? 'Staged' : 'Modified'}
                </span>
              </button>

              {/* Diff content */}
              {!section.collapsed && (
                <div
                  style={{
                    height: Math.min(
                      400,
                      Math.max(150, (section.modifiedContent.split('\n').length + 2) * 19)
                    )
                  }}
                >
                  {section.loading ? (
                    <div className="flex items-center justify-center h-full text-muted-foreground text-xs">
                      Loading...
                    </div>
                  ) : (
                    <DiffEditor
                      height="100%"
                      language={language}
                      original={section.originalContent}
                      modified={section.modifiedContent}
                      theme={isDark ? 'vs-dark' : 'vs'}
                      options={{
                        readOnly: true,
                        renderSideBySide: sideBySide,
                        minimap: { enabled: false },
                        scrollBeyondLastLine: false,
                        fontSize: settings?.terminalFontSize ?? 13,
                        fontFamily: settings?.terminalFontFamily || 'monospace',
                        lineNumbers: 'on',
                        automaticLayout: true,
                        renderOverviewRuler: false,
                        scrollbar: { vertical: 'hidden' }
                      }}
                    />
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
