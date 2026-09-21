import { useCallback, useMemo, useState } from 'react'
import { AlertCircle, Save } from 'lucide-react'
import { computeEditorFontSize, resolveEditorFontFamilyOrInherit } from '@/lib/editor-font-zoom'
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
import { IpynbCellToolbar, IpynbToolbarButton } from './IpynbCellToolbar'
import { IpynbCodeCell, IpynbEditableTextCell, IpynbMarkdownCell } from './IpynbCellEditor'
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
  const settings = useAppStore((s) => s.settings)
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

  const handleNotebookPointerDownCapture = useCallback(
    (event: React.PointerEvent<HTMLDivElement>): void => {
      if (editingCellKey === null) {
        return
      }
      const target = event.target instanceof Element ? event.target : null
      if (!target?.closest('.monaco-editor')) {
        setEditingCellKey(null)
      }
    },
    [editingCellKey]
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
      style={{ fontSize, fontFamily: resolveEditorFontFamilyOrInherit(settings) }}
      onKeyDownCapture={handleNotebookKeyDownCapture}
      onPointerDownCapture={handleNotebookPointerDownCapture}
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
          <span className="rounded-sm border border-border bg-muted px-1.5 py-0.5 font-medium text-muted-foreground">
            {translate('auto.components.editor.IpynbViewer.329764e9fc', 'BETA')}
          </span>
          <span className="font-mono">
            {translate('auto.components.editor.IpynbViewer.8c3b21369a', 'nbformat')}{' '}
            {notebook.nbformat}
          </span>
        </div>
      </div>
      <div className="mx-auto flex max-w-[980px] flex-col gap-3 px-5 py-5">
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
              <section
                key={cellKey}
                className="overflow-hidden rounded-md border border-border bg-background"
              >
                <IpynbCellToolbar
                  cell={cell}
                  index={index}
                  running={execution.runningCellIndex === index}
                  canMoveUp={index > 0}
                  canMoveDown={index < notebook.cells.length - 1}
                  onRun={() => void execution.runCell(index)}
                  onKindChange={(kind) => updateCellKind(index, kind)}
                  onInsertAbove={(kind) => insertCell(index, kind)}
                  onInsertBelow={(kind) => insertCell(index + 1, kind)}
                  onMoveUp={() => moveCell(index, -1)}
                  onMoveDown={() => moveCell(index, 1)}
                  onDelete={() => deleteCell(index)}
                />
                {cell.kind === 'markdown' ? (
                  <div className="grid gap-0 lg:grid-cols-2">
                    <IpynbEditableTextCell
                      source={source}
                      onChange={(nextSource) => updateCellSource(index, nextSource)}
                    />
                    <div className="border-t border-border/50 lg:border-l lg:border-t-0">
                      <IpynbMarkdownCell source={source} />
                    </div>
                  </div>
                ) : cell.kind === 'code' ? (
                  <IpynbCodeCell
                    cell={cell}
                    source={source}
                    active={editingCellKey === cellKey}
                    onActivate={() => setEditingCellKey(cellKey)}
                    onDeactivate={() =>
                      setEditingCellKey((current) => (current === cellKey ? null : current))
                    }
                    onChange={(nextSource) => updateCellSource(index, nextSource)}
                    onSaveRequest={saveNotebook}
                  />
                ) : (
                  <IpynbEditableTextCell
                    source={source}
                    onChange={(nextSource) => updateCellSource(index, nextSource)}
                  />
                )}
                <IpynbCellOutputs cell={cell} />
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
