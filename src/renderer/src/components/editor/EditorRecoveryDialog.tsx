import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { RotateCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { normalizeExecutionHostId } from '../../../../shared/execution-host'
import type { EditorRecoveryDraft, EditorRecoveryEntry } from '../../../../shared/editor-recovery'
import { selectExecutionHostDisplayLabel } from '@/lib/execution-host-display-label'
import { getEditorRecoveryCheckpoint, flushEditorRecovery } from '@/lib/editor-recovery-checkpoints'
import {
  getExternalRecoveryBuffers,
  getExternalRecoveryVersion,
  subscribeExternalRecoveryBuffers
} from '@/lib/editor-recovery-external-buffers'

const PREVIEW_CHARACTERS = 100_000
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export default function EditorRecoveryDialog(): React.JSX.Element {
  const open = useAppStore((state) => state.activeModal === 'editor-recovery')
  const openFiles = useAppStore((state) => state.openFiles)
  const closeModal = useAppStore((state) => state.closeModal)
  const api = window.api.session.recovery
  useSyncExternalStore(subscribeExternalRecoveryBuffers, getExternalRecoveryVersion)
  const [entries, setEntries] = useState<EditorRecoveryEntry[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [preview, setPreview] = useState<EditorRecoveryDraft | null>(null)
  const [query, setQuery] = useState('')
  const [limit, setLimit] = useState(100)
  const [loading, setLoading] = useState(false)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [exportedPath, setExportedPath] = useState<string | null>(null)

  const reload = useCallback(async (): Promise<void> => {
    if (!api) {
      return
    }
    setLoading(true)
    setError(null)
    try {
      try {
        await flushEditorRecovery()
      } catch (failure) {
        setError(message(failure))
      }
      const loaded = await api.list()
      setEntries(loaded)
      setSelectedId((current) =>
        loaded.some((entry) => entry.id === current) ? current : (loaded[0]?.id ?? null)
      )
    } catch (failure) {
      setError(message(failure))
    } finally {
      setLoading(false)
    }
  }, [api])

  useEffect(() => {
    if (open) {
      void reload()
    }
  }, [open, reload])
  useEffect(() => {
    if (!open || !api || !selectedId) {
      setPreview(null)
      return
    }
    let cancelled = false
    setPreview(null)
    setPreviewLoading(true)
    setConfirmDiscard(false)
    void api
      .read(selectedId)
      .then((draft) => {
        if (!cancelled) {
          setPreview(draft)
        }
      })
      .catch((failure) => {
        if (!cancelled) {
          setError(message(failure))
        }
      })
      .finally(() => {
        if (!cancelled) {
          setPreviewLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [api, open, selectedId, entries])

  const selected = entries.find((entry) => entry.id === selectedId)
  const active = [...openFiles, ...getExternalRecoveryBuffers().map((buffer) => buffer.file)].some(
    (file) =>
      file.isDirty && (getEditorRecoveryCheckpoint(file.id)?.id ?? file.recoveryId) === selectedId
  )
  const filtered = entries.filter((entry) =>
    `${entry.filePath} ${entry.relativePath} ${entry.hostId}`
      .toLowerCase()
      .includes(query.toLowerCase())
  )
  const hostLabel = (entry: EditorRecoveryEntry): string =>
    selectExecutionHostDisplayLabel(
      useAppStore.getState(),
      normalizeExecutionHostId(entry.hostId) ?? 'local',
      { sshEnvironmentId: entry.runtimeEnvironmentId }
    )

  const exportCopy = async (): Promise<void> => {
    if (!api || !preview) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      setExportedPath(await api.export({ id: preview.id, revision: preview.revision }))
    } catch (failure) {
      setError(message(failure))
    } finally {
      setBusy(false)
    }
  }
  const discard = async (): Promise<void> => {
    if (!api || !preview) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      const [ack] = await api.apply([
        { kind: 'resolve', id: preview.id, expectedRevision: preview.revision }
      ])
      if (!ack?.revision) {
        throw new Error(
          translate('editorRecovery.changed', 'The draft changed. Refresh and retry.')
        )
      }
      setConfirmDiscard(false)
      await reload()
    } catch (failure) {
      setError(message(failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          closeModal()
        }
      }}
    >
      <DialogContent className="max-h-[85vh] sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{translate('editorRecovery.title', 'Recover unsaved changes')}</DialogTitle>
          <DialogDescription>
            {translate(
              'editorRecovery.description',
              'Preview draft copies saved on this client and recover them to a separate file.'
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[65vh] space-y-4 overflow-y-auto scrollbar-sleek">
          <div className="flex items-center gap-2">
            <Input
              aria-label={translate('editorRecovery.search', 'Search drafts')}
              placeholder={translate('editorRecovery.searchPlaceholder', 'Search by file or host…')}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value)
                setLimit(100)
              }}
            />
            <Button
              variant="outline"
              size="icon"
              disabled={loading || busy}
              aria-label={translate('editorRecovery.refresh', 'Refresh drafts')}
              onClick={() => void reload()}
            >
              <RotateCw className="size-4" />
            </Button>
          </div>
          {!api ? (
            <p className="text-sm text-muted-foreground">
              {translate('editorRecovery.unavailable', 'Recovery is unavailable in this client.')}
            </p>
          ) : null}
          {loading ? (
            <p role="status" className="text-sm text-muted-foreground">
              {translate('editorRecovery.loading', 'Loading drafts…')}
            </p>
          ) : null}
          {!loading && api && filtered.length === 0 ? (
            <p className="py-4 text-sm text-muted-foreground">
              {translate('editorRecovery.empty', 'No recovery drafts found.')}
            </p>
          ) : null}
          {filtered.length > 0 ? (
            <div
              aria-label={translate('editorRecovery.drafts', 'Recovery drafts')}
              className="max-h-52 space-y-1 overflow-y-auto scrollbar-sleek"
            >
              {filtered.slice(0, limit).map((entry) => (
                <Button
                  key={entry.id}
                  variant={entry.id === selectedId ? 'secondary' : 'ghost'}
                  className="h-auto w-full text-left"
                  aria-pressed={entry.id === selectedId}
                  onClick={() => {
                    setSelectedId(entry.id)
                    setError(null)
                    setExportedPath(null)
                  }}
                >
                  <span className="flex w-full flex-col items-start gap-1">
                    <span className="w-full truncate text-sm">
                      {entry.relativePath || entry.filePath}
                    </span>
                    <span className="w-full truncate text-xs text-muted-foreground">
                      {hostLabel(entry)} ·{' '}
                      {entry.updatedAt > 0
                        ? new Date(entry.updatedAt).toLocaleString()
                        : translate('editorRecovery.imported', 'Imported from a saved session')}
                    </span>
                  </span>
                </Button>
              ))}
              {filtered.length > limit ? (
                <Button variant="ghost" onClick={() => setLimit((current) => current + 100)}>
                  {translate('editorRecovery.more', 'Show more drafts')}
                </Button>
              ) : null}
            </div>
          ) : null}
          {selected ? (
            <div className="space-y-2">
              <p className="break-all text-xs text-muted-foreground">{selected.filePath}</p>
              {previewLoading ? (
                <p role="status" className="text-sm text-muted-foreground">
                  {translate('editorRecovery.previewLoading', 'Loading preview…')}
                </p>
              ) : null}
              {preview ? (
                <Textarea
                  variant="code"
                  readOnly
                  aria-label={translate('editorRecovery.preview', 'Draft preview')}
                  className="h-48"
                  value={preview.content.slice(0, PREVIEW_CHARACTERS)}
                />
              ) : null}
              {preview && preview.content.length > PREVIEW_CHARACTERS ? (
                <p className="text-xs text-muted-foreground">
                  {translate(
                    'editorRecovery.previewLimited',
                    'The preview is shortened. Recovery includes the complete draft.'
                  )}
                </p>
              ) : null}
              {active ? (
                <p className="text-xs text-muted-foreground">
                  {translate('editorRecovery.openInEditor', 'This draft is open in the editor.')}
                </p>
              ) : null}
            </div>
          ) : null}
          {error ? (
            <p role="alert" className="break-words text-sm text-destructive">
              {error}
            </p>
          ) : null}
          {exportedPath ? (
            <p role="status" className="break-all text-sm">
              {translate('editorRecovery.exported', 'Recovered copy:')} <code>{exportedPath}</code>
            </p>
          ) : null}
        </div>
        <DialogFooter>
          {confirmDiscard ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm">
                {translate('editorRecovery.confirmDiscard', 'Discard this recovery copy?')}
              </span>
              <Button variant="ghost" onClick={() => setConfirmDiscard(false)}>
                {translate('editorRecovery.keep', 'Keep')}
              </Button>
              <Button variant="ghost" disabled={busy} onClick={() => void discard()}>
                {translate('editorRecovery.discard', 'Discard')}
              </Button>
            </div>
          ) : (
            <Button
              variant="ghost"
              disabled={!preview || busy || active}
              onClick={() => setConfirmDiscard(true)}
            >
              {translate('editorRecovery.discard', 'Discard')}
            </Button>
          )}
          <Button disabled={!preview || busy} onClick={() => void exportCopy()}>
            {translate('editorRecovery.recoverCopy', 'Recover copy…')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
