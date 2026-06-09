import { useEffect, useState } from 'react'
import { Bookmark, LoaderCircle, Pencil, Plus, Save, Trash2, X } from 'lucide-react'
import type { SparsePreset } from '../../../../shared/types'
import { useAppStore } from '../../store'
import { cn } from '@/lib/utils'
import { parseSparsePresetDirectories } from '@/lib/sparse-preset-draft'
import { useMountedRef } from '@/hooks/useMountedRef'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { getSparsePresetOperationErrorMessage } from './sparse-preset-operation-error'
import { formatSparsePresetUpdatedAt } from './sparse-preset-date'
import { translate } from '@/i18n/i18n'

type SparsePresetSettingsSectionProps = {
  repoId: string
}

type SparsePresetDraft = {
  mode: 'new' | 'edit'
  presetId?: string
  name: string
  directoriesText: string
}

function SparsePresetDirectoryPreview({
  directories
}: {
  directories: string[]
}): React.JSX.Element {
  const visibleDirectories = directories.slice(0, 6)
  const hiddenCount = directories.length - visibleDirectories.length

  return (
    <div className="flex flex-wrap gap-1.5">
      {visibleDirectories.map((directory) => (
        <span
          key={directory}
          className="min-w-0 max-w-full truncate rounded-md border border-border/50 bg-muted/35 px-2 py-1 font-mono text-[11px] text-foreground/80"
          title={directory}
        >
          {directory}
        </span>
      ))}
      {hiddenCount > 0 ? (
        <span className="rounded-md border border-border/50 bg-muted/35 px-2 py-1 text-[11px] text-muted-foreground">
          +{hiddenCount} {translate("auto.components.settings.SparsePresetSettingsSection.8b64731aaf", "more")}</span>
      ) : null}
    </div>
  )
}

export function SparsePresetSettingsSection({
  repoId
}: SparsePresetSettingsSectionProps): React.JSX.Element {
  const presets = useAppStore((s) => s.sparsePresetsByRepo[repoId])
  const loadStatus = useAppStore((s) => s.sparsePresetsLoadStatusByRepo[repoId] ?? 'idle')
  const loadError = useAppStore((s) => s.sparsePresetsErrorByRepo[repoId])
  const fetchSparsePresets = useAppStore((s) => s.fetchSparsePresets)
  const saveSparsePreset = useAppStore((s) => s.saveSparsePreset)
  const removeSparsePreset = useAppStore((s) => s.removeSparsePreset)

  const [draft, setDraft] = useState<SparsePresetDraft | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null)
  const [deletingPresetId, setDeletingPresetId] = useState<string | null>(null)
  const [operationError, setOperationError] = useState<string | null>(null)
  const mountedRef = useMountedRef()

  useEffect(() => {
    if (presets === undefined && loadStatus === 'idle') {
      void fetchSparsePresets(repoId).catch((error: unknown) => {
        if (mountedRef.current) {
          setOperationError(
            getSparsePresetOperationErrorMessage(error, 'Failed to load sparse presets.')
          )
        }
      })
    }
  }, [fetchSparsePresets, loadStatus, mountedRef, presets, repoId])

  const sortedPresets = presets ?? []
  const parsedDirectories = draft ? parseSparsePresetDirectories(draft.directoriesText) : null
  const trimmedName = draft?.name.trim() ?? ''
  const lowerName = trimmedName.toLowerCase()
  const collidingPreset =
    draft && trimmedName
      ? (sortedPresets.find(
          (preset) => preset.id !== draft.presetId && preset.name.toLowerCase() === lowerName
        ) ?? null)
      : null

  const nameError =
    draft && trimmedName.length === 0
      ? 'Name is required.'
      : trimmedName.length > 80
        ? 'Name must be 80 characters or fewer.'
        : collidingPreset
          ? `"${collidingPreset.name}" already exists.`
          : null
  const canSaveDraft =
    !!draft && !submitting && !nameError && parsedDirectories !== null && !parsedDirectories.error
  const visibleError = operationError ?? loadError ?? null

  const startNewPreset = (): void => {
    setConfirmingDeleteId(null)
    setOperationError(null)
    setDraft({
      mode: 'new',
      name: '',
      directoriesText: ''
    })
  }

  const startEditPreset = (preset: SparsePreset): void => {
    setConfirmingDeleteId(null)
    setOperationError(null)
    setDraft({
      mode: 'edit',
      presetId: preset.id,
      name: preset.name,
      directoriesText: preset.directories.join('\n')
    })
  }

  const handleSaveDraft = async (): Promise<void> => {
    if (!draft || !canSaveDraft || !parsedDirectories) {
      return
    }
    setSubmitting(true)
    setOperationError(null)
    try {
      const saved = await saveSparsePreset({
        repoId,
        id: draft.presetId,
        name: trimmedName,
        directories: parsedDirectories.directories
      })
      if (saved && mountedRef.current) {
        setDraft(null)
      } else if (mountedRef.current) {
        setOperationError(
          draft.mode === 'new' ? 'Failed to save preset.' : 'Failed to update preset.'
        )
      }
    } catch (error) {
      if (mountedRef.current) {
        setOperationError(
          getSparsePresetOperationErrorMessage(
            error,
            draft.mode === 'new' ? 'Failed to save preset.' : 'Failed to update preset.'
          )
        )
      }
    } finally {
      if (mountedRef.current) {
        setSubmitting(false)
      }
    }
  }

  const handleDeletePreset = async (preset: SparsePreset): Promise<void> => {
    if (confirmingDeleteId !== preset.id) {
      setConfirmingDeleteId(preset.id)
      return
    }
    setDeletingPresetId(preset.id)
    setOperationError(null)
    try {
      // Why: SSH-backed settings can fail after confirmation; keep local edit
      // state intact until persistence actually reports success.
      await removeSparsePreset({ repoId, presetId: preset.id })
      if (mountedRef.current) {
        if (draft?.presetId === preset.id) {
          setDraft(null)
        }
        setConfirmingDeleteId(null)
      }
    } catch (error) {
      if (mountedRef.current) {
        setOperationError(getSparsePresetOperationErrorMessage(error, 'Failed to delete preset.'))
        setConfirmingDeleteId(preset.id)
      }
    } finally {
      if (mountedRef.current) {
        setDeletingPresetId(null)
      }
    }
  }

  const renderDraftEditor = (): React.JSX.Element | null => {
    if (!draft) {
      return null
    }

    return (
      <div className="rounded-xl border border-border/60 bg-background/80 p-4 shadow-sm">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="space-y-0.5">
            <h5 className="text-sm font-semibold">
              {draft.mode === "new" ? translate("auto.components.settings.SparsePresetSettingsSection.d7565029a9", "New Preset") : translate("auto.components.settings.SparsePresetSettingsSection.623b4cf910", "Edit Preset")}
            </h5>
            <p className="text-xs text-muted-foreground">
              {translate("auto.components.settings.SparsePresetSettingsSection.694cc55ecb", "Saved directories are used when creating sparse worktrees for this repository.")}</p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={translate("auto.components.settings.SparsePresetSettingsSection.b9922ec194", "Cancel preset edit")}
            onClick={() => setDraft(null)}
            disabled={submitting}
          >
            <X className="size-3.5" />
          </Button>
        </div>

        <div className="grid gap-4 md:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
          <div className="space-y-2">
            <Label htmlFor="sparse-preset-settings-name">{translate("auto.components.settings.SparsePresetSettingsSection.a6fcdd9e3c", "Name")}</Label>
            <Input
              id="sparse-preset-settings-name"
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              placeholder={translate("auto.components.settings.SparsePresetSettingsSection.3b6f1abd3e", "e.g. web-only")}
              maxLength={80}
              autoComplete="off"
              spellCheck={false}
              className="h-9 text-sm"
            />
            {nameError ? <p className="text-xs text-destructive">{nameError}</p> : null}
          </div>

          <div className="space-y-2">
            <Label htmlFor="sparse-preset-settings-directories">{translate("auto.components.settings.SparsePresetSettingsSection.caf33029cc", "Directories")}</Label>
            <textarea
              id="sparse-preset-settings-directories"
              value={draft.directoriesText}
              onChange={(event) => setDraft({ ...draft, directoriesText: event.target.value })}
              placeholder={translate("auto.components.settings.SparsePresetSettingsSection.fde7ff2cc3", "packages/web shared/ui")}
              rows={5}
              spellCheck={false}
              className="w-full min-w-0 resize-y rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs shadow-xs outline-none transition-[color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
            />
            {parsedDirectories?.error ? (
              <p className="text-xs text-destructive">{parsedDirectories.error}</p>
            ) : (
              <p className="text-xs text-muted-foreground">
                {parsedDirectories?.directories.length === 1
                  ? translate("auto.components.settings.SparsePresetSettingsSection.b532b9c17d", "1 directory will be saved.")
                  : translate("auto.components.settings.SparsePresetSettingsSection.3dfa765ca7", "{{value0}} directories will be saved.", { value0: parsedDirectories?.directories.length ?? 0 })}{' '}
                {translate("auto.components.settings.SparsePresetSettingsSection.c240a16f25", "Use repo-relative paths like packages/web or apps/api.")}</p>
            )}
          </div>
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setDraft(null)}
            disabled={submitting}
          >
            {translate("auto.components.settings.SparsePresetSettingsSection.2d7d45e991", "Cancel")}</Button>
          <Button
            type="button"
            size="sm"
            onClick={() => void handleSaveDraft()}
            disabled={!canSaveDraft}
          >
            {submitting ? (
              <LoaderCircle className="size-3.5 animate-spin" />
            ) : (
              <Save className="size-3.5" />
            )}
            {translate("auto.components.settings.SparsePresetSettingsSection.a05bc9183f", "Save Preset")}</Button>
        </div>
      </div>
    )
  }

  return (
    <section className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold">{translate("auto.components.settings.SparsePresetSettingsSection.388513be2d", "Sparse Checkout Presets")}</h3>
          <p className="text-xs text-muted-foreground">
            {translate("auto.components.settings.SparsePresetSettingsSection.17f8c4ce10", "Manage saved directory sets for sparse worktree creation.")}</p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={startNewPreset}
          disabled={!!draft}
        >
          <Plus className="size-3.5" />
          {translate("auto.components.settings.SparsePresetSettingsSection.d7565029a9", "New Preset")}</Button>
      </div>

      {visibleError ? (
        <div
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          {visibleError}
        </div>
      ) : null}

      {renderDraftEditor()}

      {presets === undefined ? (
        <div className="rounded-xl border border-dashed border-border/60 bg-background/60 px-4 py-6 text-sm text-muted-foreground">
          {loadError ? translate("auto.components.settings.SparsePresetSettingsSection.92c08ccae3", "Sparse presets could not be loaded.") : translate("auto.components.settings.SparsePresetSettingsSection.8deb7024ab", "Loading sparse presets...")}
        </div>
      ) : sortedPresets.length === 0 && !draft ? (
        <div className="rounded-xl border border-dashed border-border/60 bg-background/60 px-4 py-6 text-sm text-muted-foreground">
          {translate("auto.components.settings.SparsePresetSettingsSection.88bfbf1a9c", "No sparse presets saved for this repository.")}</div>
      ) : (
        <div className="space-y-2">
          {sortedPresets.map((preset) => {
            // Why: users can already have locally persisted presets from older
            // builds or hand-edited state; a bad timestamp must not blank Settings.
            const updatedLabel = formatSparsePresetUpdatedAt(preset.updatedAt)
            const isDeleting = deletingPresetId === preset.id

            return (
              <div
                key={preset.id}
                className="rounded-xl border border-border/50 bg-background/70 px-4 py-3 shadow-sm"
              >
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/50 bg-muted/30">
                    <Bookmark className="size-4 text-muted-foreground" />
                  </div>
                  <div className="min-w-0 flex-1 space-y-2">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <h4 className="min-w-0 truncate text-sm font-medium">{preset.name}</h4>
                      <span className="text-[11px] text-muted-foreground">
                        {preset.directories.length === 1
                          ? translate("auto.components.settings.SparsePresetSettingsSection.9d3c087fc0", "1 directory")
                          : translate("auto.components.settings.SparsePresetSettingsSection.d7b3f0bdc3", "{{value0}} directories", { value0: preset.directories.length })}
                      </span>
                      <span className="text-[11px] text-muted-foreground">
                        {updatedLabel ? translate("auto.components.settings.SparsePresetSettingsSection.568d7e1e49", "Updated {{value0}}", { value0: updatedLabel }) : translate("auto.components.settings.SparsePresetSettingsSection.ba9ad2d4cd", "Updated date unknown")}
                      </span>
                    </div>
                    <SparsePresetDirectoryPreview directories={preset.directories} />
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={translate("auto.components.settings.SparsePresetSettingsSection.fe1f2c6572", "Edit {{value0}}", { value0: preset.name })}
                      onClick={() => startEditPreset(preset)}
                      disabled={submitting || deletingPresetId !== null}
                    >
                      <Pencil className="size-3.5" />
                    </Button>
                    <Button
                      type="button"
                      variant={confirmingDeleteId === preset.id ? 'destructive' : 'ghost'}
                      size="sm"
                      aria-label={translate("auto.components.settings.SparsePresetSettingsSection.6fa754d20f", "Delete {{value0}}", { value0: preset.name })}
                      onClick={() => void handleDeletePreset(preset)}
                      onBlur={() => setConfirmingDeleteId(null)}
                      disabled={submitting || (deletingPresetId !== null && !isDeleting)}
                      className={cn(
                        'w-[6.5rem] px-2 text-xs',
                        confirmingDeleteId !== preset.id && 'text-muted-foreground'
                      )}
                    >
                      {isDeleting ? (
                        <LoaderCircle className="size-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="size-3.5" />
                      )}
                      {isDeleting
                        ? translate("auto.components.settings.SparsePresetSettingsSection.a7bcf206b1", "Deleting")
                        : confirmingDeleteId === preset.id
                          ? translate("auto.components.settings.SparsePresetSettingsSection.755c6a1a0d", "Confirm")
                          : translate("auto.components.settings.SparsePresetSettingsSection.6fa754d20f", "Delete")}
                    </Button>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
