import { useCallback, useMemo, useState } from 'react'
import { AlertCircle, Save } from 'lucide-react'
import { computeEditorFontSize } from '@/lib/editor-font-zoom'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { useShortcutKeyDetails } from '@/hooks/useShortcutLabel'
import { translate } from '@/i18n/i18n'
import { editorShortcutMatches } from './editor-shortcuts'
import { IpynbCellToolbar, IpynbRunPrompt, IpynbToolbarButton } from './IpynbCellToolbar'
import { IpynbCellSource } from './IpynbCellEditor'
import { IpynbCellOutputs } from './IpynbCellOutputs'
import { parseIpynb } from './ipynb-parse'
import {
  getIpynbCellKey,
  hasIpynbSourceDraft,
  useIpynbDocumentEditing
} from './useIpynbDocumentEditing'
import { useIpynbCellExecution } from './useIpynbCellExecution'
import { useIpynbScrollRestoration } from './useIpynbScrollRestoration'

type IpynbViewerProps = {
  content: string
  fileId: string
  filePath: string
  worktreeId: string
  scrollCacheKey: string
  onContentChange: (content: string) => void
  onDirtyStateHint: (dirty: boolean) => void
  onSave: (content: string) => Promise<boolean>
}

export default function IpynbViewer({
  content,
  fileId,
  filePath,
  worktreeId,
  scrollCacheKey,
  onContentChange,
  onDirtyStateHint,
  onSave
}: IpynbViewerProps): React.JSX.Element {
  const editorFontZoomLevel = useAppStore((s) => s.editorFontZoomLevel)
  const [editingCellKey, setEditingCellKey] = useState<string | null>(null)
  const parsed = useMemo(() => {
    try {
      return { notebook: parseIpynb(content), error: null as string | null }
    } catch (error) {
      return {
        notebook: null,
        error: error instanceof Error ? error.message : 'Invalid notebook'
      }
    }
  }, [content])
  const deactivateEditor = useCallback((): void => setEditingCellKey(null), [])
  const {
    rootRef,
    setRootRef,
    sourceDrafts,
    flushSourceDrafts,
    applyContent,
    updateCellSource,
    updateCellKind,
    insertCell,
    moveCell,
    deleteCell
  } = useIpynbDocumentEditing({
    content,
    fileId,
    notebook: parsed.notebook,
    onContentChange,
    onDirtyStateHint,
    onDeactivateEditor: deactivateEditor
  })
  const execution = useIpynbCellExecution({
    filePath,
    worktreeId,
    flushSourceDrafts,
    applyContent,
    onSave
  })
  useIpynbScrollRestoration(rootRef, scrollCacheKey, content)
  const saveShortcut = useShortcutKeyDetails('editor.save')
  const fontSize = computeEditorFontSize(13, editorFontZoomLevel)

  const saveNotebook = useCallback(async (): Promise<void> => {
    const latestContent = flushSourceDrafts()
    await onSave(latestContent)
  }, [flushSourceDrafts, onSave])

  const handleNotebookKeyDownCapture = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>): void => {
      if (event.repeat || !editorShortcutMatches('editor.save', event)) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      void saveNotebook()
    },
    [saveNotebook]
  )

  if (parsed.error || !parsed.notebook) {
    return (
      <div className="flex h-full items-center justify-center bg-editor-surface p-6 text-sm text-muted-foreground">
        <div className="flex max-w-md items-start gap-3 rounded-md border border-border bg-background p-4">
          <AlertCircle className="mt-0.5 size-4 text-destructive" />
          <div>
            <div className="font-medium text-foreground">
              {translate(
                'auto.components.editor.IpynbViewer.c1601b23b2',
                'Unable to render notebook'
              )}
            </div>
            <div className="mt-1">{parsed.error}</div>
          </div>
        </div>
      </div>
    )
  }

  const { notebook } = parsed
  return (
    <div
      ref={setRootRef}
      className="h-full min-h-0 overflow-auto bg-editor-surface scrollbar-editor"
      style={{ fontSize }}
      onKeyDownCapture={handleNotebookKeyDownCapture}
    >
      <div className="sticky top-0 z-10 flex items-center gap-3 border-b border-border/60 bg-background/95 px-4 py-2 text-xs text-muted-foreground backdrop-blur">
        <span className="font-medium text-foreground">{filePath.split(/[/\\]/).pop()}</span>
        <span>
          {notebook.cells.length}{' '}
          {translate('auto.components.editor.IpynbViewer.07e7d96612', 'cells')}
        </span>
        <span>{notebook.language}</span>
        {notebook.kernelName ? <span>{notebook.kernelName}</span> : null}
        {execution.runError ? <span className="text-destructive">{execution.runError}</span> : null}
        <div className="ml-auto flex items-center gap-2">
          <IpynbToolbarButton
            label={translate('auto.components.editor.IpynbViewer.15ec40a735', 'Save notebook')}
            shortcut={saveShortcut}
            onClick={() => void saveNotebook()}
          >
            <Save className="size-3.5" />
          </IpynbToolbarButton>
        </div>
      </div>
      <div className="mx-auto flex max-w-[980px] flex-col gap-2 py-5 pr-5 pl-2">
        {notebook.cells.length === 0 ? (
          <div className="flex items-center justify-center rounded-md border border-border bg-background p-8 text-sm text-muted-foreground">
            {translate('auto.components.editor.IpynbViewer.d6f37a640b', 'Empty notebook')}
          </div>
        ) : (
          notebook.cells.map((cell, index) => {
            const cellKey = getIpynbCellKey(cell, index)
            const source = hasIpynbSourceDraft(sourceDrafts, cellKey)
              ? (sourceDrafts[cellKey] ?? '')
              : cell.source
            return (
              <section key={cellKey} className="group relative flex gap-2 py-1.5">
                {/* Mirrors the code surface's border and padding so the count shares the first line's box. */}
                <div className="flex w-12 shrink-0 justify-center border-y border-transparent py-1">
                  {cell.kind === 'code' ? (
                    <IpynbRunPrompt
                      executionCount={cell.executionCount}
                      running={execution.runningCellIndex === index}
                      onRun={() => void execution.runCell(index)}
                    />
                  ) : null}
                </div>
                <div className="min-w-0 flex-1">
                  <IpynbCellSource
                    cell={cell}
                    source={source}
                    active={editingCellKey === cellKey}
                    onActivate={() => setEditingCellKey(cellKey)}
                    onDeactivate={() =>
                      setEditingCellKey((current) => (current === cellKey ? null : current))
                    }
                    onChange={(nextSource) => updateCellSource(index, nextSource)}
                  />
                  <IpynbCellOutputs cell={cell} />
                </div>
                <IpynbCellToolbar
                  kind={cell.kind}
                  canMoveUp={index > 0}
                  canMoveDown={index < notebook.cells.length - 1}
                  onKindChange={(kind) => updateCellKind(index, kind)}
                  onInsert={(offset, kind) => insertCell(index + offset, kind)}
                  onMove={(direction) => moveCell(index, direction)}
                  onDelete={() => deleteCell(index)}
                />
              </section>
            )
          })
        )}
      </div>
      <Dialog
        open={execution.pendingRunCellIndex !== null}
        onOpenChange={(open) => {
          if (!open) {
            execution.cancelPendingRun()
          }
        }}
      >
        <DialogContent className="max-w-md sm:max-w-md" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle className="text-sm">
              {translate('auto.components.editor.IpynbViewer.9e06ae5d36', 'Run Notebook Code?')}
            </DialogTitle>
            <DialogDescription className="text-xs">
              {translate(
                'auto.components.editor.IpynbViewer.10ed04a685',
                'Notebook cells execute local Python on this machine from the notebook folder. Only run cells from files you trust.'
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" size="sm" onClick={execution.cancelPendingRun}>
              {translate('auto.components.editor.IpynbViewer.7f0d7077c6', 'Cancel')}
            </Button>
            <Button type="button" size="sm" autoFocus onClick={execution.confirmPendingRun}>
              {translate('auto.components.editor.IpynbViewer.859bf9fc21', 'Run cell')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
