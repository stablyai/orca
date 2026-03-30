import React, { lazy, type MutableRefObject } from 'react'
import { LazySection } from './LazySection'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { DiffEditor, type DiffOnMount } from '@monaco-editor/react'
import type { editor as monacoEditor } from 'monaco-editor'
import { basename, dirname } from '@/lib/path'
import { detectLanguage } from '@/lib/language-detect'
import { cn } from '@/lib/utils'
import type { GitDiffResult } from '../../../../shared/types'

const ImageDiffViewer = lazy(() => import('./ImageDiffViewer'))

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
  loadSection: (index: number) => void
  toggleSection: (index: number) => void
  setSectionHeights: React.Dispatch<React.SetStateAction<Record<number, number>>>
  setSections: React.Dispatch<React.SetStateAction<DiffSection[]>>
  modifiedEditorsRef: MutableRefObject<Map<number, monacoEditor.IStandaloneCodeEditor>>
  handleSectionSaveRef: MutableRefObject<(index: number) => Promise<void>>
}): React.JSX.Element {
  const language = detectLanguage(section.path)
  const fileName = basename(section.path)
  const parentDir = dirname(section.path)
  const dirPath = parentDir === '.' ? '' : parentDir
  const isEditable = section.area === 'unstaged'

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
      <button
        className="flex items-center gap-2 w-full px-3 py-2 text-left text-sm hover:bg-accent/30 transition-colors"
        onClick={() => toggleSection(index)}
      >
        {section.collapsed ? (
          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="font-medium">
          {fileName}
          {section.dirty && <span className="text-muted-foreground ml-1">M</span>}
        </span>
        {dirPath && <span className="text-muted-foreground text-xs">{dirPath}</span>}
        <span
          className={cn(
            'text-xs font-bold ml-auto',
            section.status === 'modified' && 'text-amber-500',
            section.status === 'added' && 'text-green-500',
            section.status === 'deleted' && 'text-red-500'
          )}
        >
          {section.area === 'staged'
            ? 'Staged'
            : section.area === 'unstaged'
              ? 'Modified'
              : isBranchMode
                ? 'Branch'
                : ''}
        </span>
      </button>

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
