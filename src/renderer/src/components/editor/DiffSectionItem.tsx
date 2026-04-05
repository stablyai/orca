import React, { lazy, useMemo, type MutableRefObject } from 'react'
import { LazySection } from './LazySection'
import { ChevronDown, ChevronRight, ExternalLink } from 'lucide-react'
import { DiffEditor, type DiffOnMount } from '@monaco-editor/react'
import type { editor as monacoEditor } from 'monaco-editor'
import { joinPath } from '@/lib/path'
import { detectLanguage } from '@/lib/language-detect'
import { useAppStore } from '@/store'
import type { GitDiffResult } from '../../../../shared/types'

const ImageDiffViewer = lazy(() => import('./ImageDiffViewer'))

/**
 * Compute approximate added/removed line counts by matching lines
 * between original and modified content using a multiset approach.
 * Not a true Myers diff, but fast and accurate enough for stat display.
 */
function computeLineStats(
  original: string,
  modified: string,
  status: string
): { added: number; removed: number } | null {
  // Why: for very large files (e.g. package-lock.json), splitting and
  // iterating synchronously in the React render cycle would block the
  // main thread and freeze the UI. Return null to skip stats display.
  if (original.length + modified.length > 500_000) {
    return null
  }
  if (status === 'added') {
    return { added: modified ? modified.split('\n').length : 0, removed: 0 }
  }
  if (status === 'deleted') {
    return { added: 0, removed: original ? original.split('\n').length : 0 }
  }

  const origLines = original.split('\n')
  const modLines = modified.split('\n')

  const origMap = new Map<string, number>()
  for (const line of origLines) {
    origMap.set(line, (origMap.get(line) ?? 0) + 1)
  }

  let matched = 0
  for (const line of modLines) {
    const count = origMap.get(line) ?? 0
    if (count > 0) {
      origMap.set(line, count - 1)
      matched++
    }
  }

  return {
    added: modLines.length - matched,
    removed: origLines.length - matched
  }
}

type DiffSection = {
  key: string
  path: string
  status: string
  area?: 'staged' | 'unstaged' | 'untracked'
  oldPath?: string
  originalContent: string
  modifiedContent: string
  collapsed: boolean
  loading: boolean
  dirty: boolean
  diffResult: GitDiffResult | null
}

export function DiffSectionItem({
  section,
  index,
  isBranchMode,
  sideBySide,
  isDark,
  settings,
  sectionHeight,
  worktreeId,
  worktreeRoot,
  loadSection,
  toggleSection,
  setSectionHeights,
  setSections,
  modifiedEditorsRef,
  handleSectionSaveRef
}: {
  section: DiffSection
  index: number
  isBranchMode: boolean
  sideBySide: boolean
  isDark: boolean
  settings: { terminalFontSize?: number; terminalFontFamily?: string } | null
  sectionHeight: number | undefined
  worktreeId: string
  /** The worktree root directory — not a file path; used to resolve absolute paths for opening files. */
  worktreeRoot: string
  loadSection: (index: number) => void
  toggleSection: (index: number) => void
  setSectionHeights: React.Dispatch<React.SetStateAction<Record<number, number>>>
  setSections: React.Dispatch<React.SetStateAction<DiffSection[]>>
  modifiedEditorsRef: MutableRefObject<Map<number, monacoEditor.IStandaloneCodeEditor>>
  handleSectionSaveRef: MutableRefObject<(index: number) => Promise<void>>
}): React.JSX.Element {
  const openFile = useAppStore((s) => s.openFile)
  const language = detectLanguage(section.path)
  const isEditable = section.area === 'unstaged'

  const lineStats = useMemo(
    () =>
      section.loading
        ? null
        : computeLineStats(section.originalContent, section.modifiedContent, section.status),
    [section.loading, section.originalContent, section.modifiedContent, section.status]
  )

  const handleOpenInEditor = (e: React.MouseEvent): void => {
    e.stopPropagation()
    const absolutePath = joinPath(worktreeRoot, section.path)
    openFile({
      filePath: absolutePath,
      relativePath: section.path,
      worktreeId,
      language,
      mode: 'edit'
    })
  }

  const handleMount: DiffOnMount = (editor, monaco) => {
    const modifiedEditor = editor.getModifiedEditor()

    const updateHeight = (): void => {
      const contentHeight = editor.getModifiedEditor().getContentHeight()
      setSectionHeights((prev) => {
        if (prev[index] === contentHeight) {
          return prev
        }
        return { ...prev, [index]: contentHeight }
      })
    }
    modifiedEditor.onDidContentSizeChange(updateHeight)
    updateHeight()

    if (!isEditable) {
      return
    }

    modifiedEditorsRef.current.set(index, modifiedEditor)
    modifiedEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () =>
      handleSectionSaveRef.current(index)
    )
    modifiedEditor.onDidChangeModelContent(() => {
      const current = modifiedEditor.getValue()
      setSections((prev) =>
        prev.map((s, i) => (i === index ? { ...s, dirty: current !== s.modifiedContent } : s))
      )
    })
  }

  return (
    <LazySection key={section.key} index={index} onVisible={loadSection}>
      <div
        className="sticky top-0 z-10 bg-background flex items-center w-full px-3 py-1.5 text-left text-xs hover:bg-accent transition-colors group cursor-pointer"
        onClick={() => toggleSection(index)}
      >
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          <span
            role="button"
            tabIndex={0}
            className="cursor-copy hover:underline"
            onMouseDown={(e) => {
              e.preventDefault()
              e.stopPropagation()
            }}
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              // Why: stop both mouse-down and click on the path affordance so
              // the parent section-toggle row cannot consume the interaction
              // before the Electron clipboard write runs.
              void window.api.ui.writeClipboardText(section.path).catch((err) => {
                console.error('Failed to copy diff path:', err)
              })
            }}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' && e.key !== ' ') {
                return
              }
              e.preventDefault()
              e.stopPropagation()
              void window.api.ui.writeClipboardText(section.path).catch((err) => {
                console.error('Failed to copy diff path:', err)
              })
            }}
            title="Copy path"
          >
            {section.path}
          </span>
          {section.dirty && <span className="font-medium ml-1">M</span>}
          {lineStats && (lineStats.added > 0 || lineStats.removed > 0) && (
            <span className="tabular-nums ml-2">
              {lineStats.added > 0 && (
                <span className="text-green-600 dark:text-green-500">+{lineStats.added}</span>
              )}
              {lineStats.added > 0 && lineStats.removed > 0 && <span> </span>}
              {lineStats.removed > 0 && <span className="text-red-500">-{lineStats.removed}</span>}
            </span>
          )}
        </span>
        <div className="flex items-center gap-1 shrink-0 ml-2">
          <button
            className="p-0.5 rounded text-muted-foreground hover:text-foreground opacity-0 group-hover:opacity-100 transition-opacity"
            onClick={handleOpenInEditor}
            title="Open in editor"
          >
            <ExternalLink className="size-3.5" />
          </button>
          {section.collapsed ? (
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
          )}
        </div>
      </div>

      {!section.collapsed && (
        <div
          style={{
            height: sectionHeight
              ? sectionHeight + 19
              : Math.max(
                  60,
                  Math.max(
                    section.originalContent.split('\n').length,
                    section.modifiedContent.split('\n').length
                  ) *
                    19 +
                    19
                )
          }}
        >
          {section.loading ? (
            <div className="flex items-center justify-center h-full text-muted-foreground text-xs">
              Loading...
            </div>
          ) : section.diffResult?.kind === 'binary' ? (
            section.diffResult.isImage ? (
              <ImageDiffViewer
                originalContent={section.diffResult.originalContent}
                modifiedContent={section.diffResult.modifiedContent}
                filePath={section.path}
                mimeType={section.diffResult.mimeType}
                sideBySide={sideBySide}
              />
            ) : (
              <div className="flex h-full items-center justify-center px-6 text-center">
                <div className="space-y-2">
                  <div className="text-sm font-medium text-foreground">Binary file changed</div>
                  <div className="text-xs text-muted-foreground">
                    {isBranchMode
                      ? 'Text diff is unavailable for this file in branch compare.'
                      : 'Text diff is unavailable for this file.'}
                  </div>
                </div>
              </div>
            )
          ) : (
            <DiffEditor
              height="100%"
              language={language}
              original={section.originalContent}
              modified={section.modifiedContent}
              theme={isDark ? 'vs-dark' : 'vs'}
              onMount={handleMount}
              options={{
                readOnly: !isEditable,
                originalEditable: false,
                renderSideBySide: sideBySide,
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
                fontSize: settings?.terminalFontSize ?? 13,
                fontFamily: settings?.terminalFontFamily || 'monospace',
                lineNumbers: 'on',
                automaticLayout: true,
                renderOverviewRuler: false,
                scrollbar: { vertical: 'hidden', handleMouseWheel: false },
                hideUnchangedRegions: { enabled: true },
                find: {
                  addExtraSpaceOnTop: false,
                  autoFindInSelection: 'never',
                  seedSearchStringFromSelection: 'never'
                }
              }}
            />
          )}
        </div>
      )}
    </LazySection>
  )
}
