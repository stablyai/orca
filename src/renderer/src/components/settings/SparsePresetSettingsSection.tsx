import { useEffect, useState } from 'react'
import { Plus } from 'lucide-react'
import type { SparsePreset } from '../../../../shared/types'
import { useAppStore } from '../../store'
import { parseSparsePresetDirectories } from '@/lib/sparse-preset-draft'
import { useMountedRef } from '@/hooks/useMountedRef'
import { Button } from '../ui/button'
import { getSparsePresetOperationErrorMessage } from './sparse-preset-operation-error'
import { SparsePresetDraftEditor, type SparsePresetDraft } from './sparse-preset-draft-editor'
import { SparsePresetSettingsRow } from './sparse-preset-settings-row'
import { translate } from '@/i18n/i18n'

type SparsePresetSettingsSectionProps = {
  repoId: string
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

  return (
    <section className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold">
            {translate(
              'auto.components.settings.SparsePresetSettingsSection.388513be2d',
              'Sparse Checkout Presets'
            )}
          </h3>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.SparsePresetSettingsSection.17f8c4ce10',
              'Manage saved directory sets for sparse worktree creation.'
            )}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={startNewPreset}
          disabled={!!draft}
        >
          <Plus className="size-3.5" />
          {translate(
            'auto.components.settings.SparsePresetSettingsSection.d7565029a9',
            'New Preset'
          )}
        </Button>
      </div>

      {visibleError ? (
        <div
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          {visibleError}
        </div>
      ) : null}

      {draft ? (
        <SparsePresetDraftEditor
          draft={draft}
          setDraft={setDraft}
          nameError={nameError}
          parsedDirectories={parsedDirectories}
          canSaveDraft={canSaveDraft}
          submitting={submitting}
          onSave={() => void handleSaveDraft()}
        />
      ) : null}

      {presets === undefined ? (
        <div className="rounded-xl border border-dashed border-border/60 bg-background/60 px-4 py-6 text-sm text-muted-foreground">
          {loadError
            ? translate(
                'auto.components.settings.SparsePresetSettingsSection.92c08ccae3',
                'Sparse presets could not be loaded.'
              )
            : translate(
                'auto.components.settings.SparsePresetSettingsSection.8deb7024ab',
                'Loading sparse presets...'
              )}
        </div>
      ) : sortedPresets.length === 0 && !draft ? (
        <div className="rounded-xl border border-dashed border-border/60 bg-background/60 px-4 py-6 text-sm text-muted-foreground">
          {translate(
            'auto.components.settings.SparsePresetSettingsSection.88bfbf1a9c',
            'No sparse presets saved for this repository.'
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {sortedPresets.map((preset) => (
            <SparsePresetSettingsRow
              key={preset.id}
              preset={preset}
              confirmingDeleteId={confirmingDeleteId}
              deletingPresetId={deletingPresetId}
              submitting={submitting}
              onEdit={startEditPreset}
              onDelete={handleDeletePreset}
              onClearDeleteConfirm={() => setConfirmingDeleteId(null)}
            />
          ))}
        </div>
      )}
    </section>
  )
}
