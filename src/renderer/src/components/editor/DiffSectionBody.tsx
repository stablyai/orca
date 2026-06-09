import { lazy, type RefObject } from 'react'
import { AlertCircle, RefreshCw } from 'lucide-react'
import { DiffEditor, type DiffOnMount } from '@monaco-editor/react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { DiffCommentPopover } from '../diff-comments/DiffCommentPopover'
import { combinedDiffSectionScrollbarOptions } from './diff-editor-scrollbar-options'
import type { DiffSection } from './diff-section-types'
import { translate } from '@/i18n/i18n'

const ImageDiffViewer = lazy(() => import('./ImageDiffViewer'))

type DiffSectionBodyProps = {
  section: DiffSection
  index: number
  sectionBodyRef: RefObject<HTMLDivElement | null>
  sectionBodyHeight: number | undefined
  useIntrinsicImageHeight: boolean
  popover: {
    lineNumber: number
    startLine?: number
    top: number
    left?: number
  } | null
  addLineCommentPlaceholder?: string
  addLineCommentLabel?: string
  isBranchMode: boolean
  sideBySide: boolean
  isDark: boolean
  language: string
  modelPathBase: string
  isEditable: boolean
  diffEditorFontSize: number
  terminalFontFamily?: string
  onCancelComment: () => void
  onSubmitComment: (body: string) => Promise<void>
  onRetrySection: (index: number) => void
  onMount: DiffOnMount
}

export function DiffSectionBody({
  section,
  index,
  sectionBodyRef,
  sectionBodyHeight,
  useIntrinsicImageHeight,
  popover,
  addLineCommentPlaceholder,
  addLineCommentLabel,
  isBranchMode,
  sideBySide,
  isDark,
  language,
  modelPathBase,
  isEditable,
  diffEditorFontSize,
  terminalFontFamily,
  onCancelComment,
  onSubmitComment,
  onRetrySection,
  onMount
}: DiffSectionBodyProps): React.JSX.Element {
  return (
    <div
      ref={sectionBodyRef}
      className={cn('relative', useIntrinsicImageHeight && 'overflow-visible')}
      style={sectionBodyHeight === undefined ? undefined : { height: sectionBodyHeight }}
    >
      {popover ? (
        // Why: key by lineNumber so the popover remounts when the anchor
        // line changes instead of leaking draft state across lines.
        <DiffCommentPopover
          key={popover.lineNumber}
          lineNumber={popover.lineNumber}
          startLine={popover.startLine}
          top={popover.top}
          left={popover.left}
          placeholder={addLineCommentPlaceholder}
          submitLabel={addLineCommentLabel}
          submittingLabel="Posting…"
          onCancel={onCancelComment}
          onSubmit={onSubmitComment}
        />
      ) : null}
      {section.loading ? (
        <div className="flex h-full items-center gap-2 bg-muted/10 px-3 text-[11px] text-muted-foreground">
          <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/50" />
          <span>{translate("auto.components.editor.DiffSectionBody.f5cf81cec2", "Loading diff...")}</span>
        </div>
      ) : section.error ? (
        <div className="flex h-full items-center justify-between gap-3 bg-muted/10 px-3 text-[11px] text-muted-foreground">
          <div className="flex min-w-0 items-center gap-2">
            <AlertCircle className="size-3.5 shrink-0 text-destructive" />
            <span className="truncate">{section.error}</span>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="h-6 shrink-0 px-2 text-[11px]"
            onClick={(event) => {
              event.stopPropagation()
              onRetrySection(index)
            }}
          >
            <RefreshCw className="size-3" />
            {translate("auto.components.editor.DiffSectionBody.cef4cf0ff5", "Retry")}</Button>
        </div>
      ) : section.diffResult?.kind === 'binary' ? (
        section.diffResult.isImage ? (
          <ImageDiffViewer
            originalContent={section.diffResult.originalContent}
            modifiedContent={section.diffResult.modifiedContent}
            filePath={section.path}
            mimeType={section.diffResult.mimeType}
            sideBySide={sideBySide}
            layout={useIntrinsicImageHeight ? 'intrinsic' : 'fill'}
          />
        ) : (
          <div className="flex h-full items-center justify-center px-6 text-center">
            <div className="space-y-2">
              <div className="text-sm font-medium text-foreground">{translate("auto.components.editor.DiffSectionBody.35d6afb5be", "Binary file changed")}</div>
              <div className="text-xs text-muted-foreground">
                {isBranchMode
                  ? translate("auto.components.editor.DiffSectionBody.7ce8436458", "Text diff is unavailable for this file in branch compare.")
                  : translate("auto.components.editor.DiffSectionBody.72f71f52eb", "Text diff is unavailable for this file.")}
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
          onMount={onMount}
          // Why: @monaco-editor/react can dispose models before widget teardown.
          // Keep them through unmount and dispose unattached models next tick.
          originalModelPath={`${modelPathBase}:original`}
          modifiedModelPath={`${modelPathBase}:modified`}
          keepCurrentOriginalModel
          keepCurrentModifiedModel
          options={{
            readOnly: !isEditable,
            originalEditable: false,
            renderSideBySide: sideBySide,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            fontSize: diffEditorFontSize,
            fontFamily: terminalFontFamily || 'monospace',
            lineNumbers: 'on',
            automaticLayout: true,
            renderOverviewRuler: false,
            scrollbar: combinedDiffSectionScrollbarOptions,
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
  )
}
