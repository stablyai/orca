import { useEffect, useRef, useState } from 'react'
import { Plus, RefreshCcw } from 'lucide-react'
import type { SparsePreset } from '../../../../../../shared/worktree/create-types'
import { useAppStore } from '../../../../store/index'
import { parseSparsePresetDirectories, validateSparsePresetName } from '@/lib/sparse-preset-draft'
import { useMountedRef } from '@/hooks/useMountedRef'
import { Button } from '../../../ui/button'
import { getSparsePresetOperationErrorMessage } from './sparse-preset-operation-error'
import { SparsePresetDraftEditor } from './sparse-preset-draft-editor'
import type { SparsePresetDraft } from '../../../sparse/SparseCheckoutPresetDraftForm'
import { SparsePresetSettingsRow } from './sparse-preset-settings-row'
import { useTranslate } from '@/i18n/use-translate'
import { SettingsGroup } from '../../section-layout/SettingsGroup'

type SparsePresetSettingsSectionProps = {
  repoId: string
}

export function SparsePresetSettingsSection({
  repoId
}: SparsePresetSettingsSectionProps): React.JSX.Element {
  const t = useTranslate()
  const repo = useAppStore((s) => s.repos.find((entry) => entry.id === repoId))
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
  const sectionRef = useRef<HTMLElement | null>(null)
  const returnPresetIdRef = useRef<string | null>(null)
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const closeDraft = (): void => {
    setDraft(null)
    setOperationError(null)
    requestAnimationFrame(() => {
      if (!mountedRef.current) {
        return
      }
      if (returnPresetIdRef.current) {
        sectionRef.current
          ?.querySelector<HTMLButtonElement>(
            `[data-edit-preset="${CSS.escape(returnPresetIdRef.current)}"]`
          )
          ?.focus()
      } else if (returnFocusRef.current?.isConnected) {
        returnFocusRef.current.focus()
      }
    })
  }
  const rememberEditorTrigger = (): void => {
    returnFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
  }

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
  const parsedDirectories = draft ? parseSparsePresetDirectories(draft.directoriesText, t) : null
  const trimmedName = draft?.name.trim() ?? ''
  const nameError = draft
    ? validateSparsePresetName(draft.name, sortedPresets, draft.presetId, t)
    : null
  const canSaveDraft =
    !!draft &&
    presets !== undefined &&
    !submitting &&
    !nameError &&
    parsedDirectories !== null &&
    !parsedDirectories.error
  const visibleError = (draft ? null : operationError) ?? loadError ?? null

  const startNewPreset = (): void => {
    if (draft || presets === undefined || deletingPresetId) {
      return
    }
    rememberEditorTrigger()
    setConfirmingDeleteId(null)
    setOperationError(null)
    returnPresetIdRef.current = null
    setDraft({
      mode: 'new',
      name: '',
      directoriesText: ''
    })
  }

  const startEditPreset = (preset: SparsePreset): void => {
    if (draft || presets === undefined || deletingPresetId) {
      return
    }
    rememberEditorTrigger()
    setConfirmingDeleteId(null)
    setOperationError(null)
    returnPresetIdRef.current = preset.id
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
        closeDraft()
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
    if (draft || deletingPresetId) {
      return
    }
    if (confirmingDeleteId !== preset.id) {
      setConfirmingDeleteId(preset.id)
      return
    }
    setDeletingPresetId(preset.id)
    setOperationError(null)
    try {
      // SSH persistence can fail after confirmation; retain edit state until removal succeeds.
      await removeSparsePreset({ repoId, presetId: preset.id })
      if (mountedRef.current) {
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

  const draftEditor = draft ? (
    <SparsePresetDraftEditor
      draft={draft}
      operationError={operationError}
      setDraft={(nextDraft) => {
        if (nextDraft) {
          setDraft(nextDraft)
        } else {
          closeDraft()
        }
      }}
      nameError={nameError}
      parsedDirectories={parsedDirectories}
      canSaveDraft={canSaveDraft}
      submitting={submitting}
      onSave={() => void handleSaveDraft()}
      repoRootPath={repo?.path}
      repoConnectionId={repo?.connectionId ?? undefined}
    />
  ) : null

  return (
    <section ref={sectionRef}>
      <SettingsGroup
        title={t(
          'auto.components.settings.SparsePresetSettingsSection.388513be2d',
          'Sparse Checkout Presets'
        )}
        description={t(
          'auto.components.settings.SparsePresetSettingsSection.17f8c4ce10',
          'Manage saved directory sets for sparse worktree creation.'
        )}
        action={
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={startNewPreset}
            disabled={!!draft || presets === undefined || deletingPresetId !== null}
          >
            <Plus className="size-3.5" />
            {t('auto.components.settings.SparsePresetSettingsSection.d7565029a9', 'New Preset')}
          </Button>
        }
      >
        {visibleError ? (
          <div
            role="alert"
            className="my-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
          >
            {visibleError}
          </div>
        ) : null}

        {draft?.mode === 'new' ? <div className="py-3">{draftEditor}</div> : null}

        {presets === undefined ? (
          <div className="py-4 text-sm text-muted-foreground">
            {loadError
              ? t(
                  'auto.components.settings.SparsePresetSettingsSection.92c08ccae3',
                  'Sparse presets could not be loaded.'
                )
              : t(
                  'auto.components.settings.SparsePresetSettingsSection.8deb7024ab',
                  'Loading sparse presets...'
                )}
            {loadError ? (
              <div className="mt-3">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={loadStatus === 'loading'}
                  onClick={() => {
                    setOperationError(null)
                    void fetchSparsePresets(repoId).catch((error: unknown) => {
                      if (mountedRef.current) {
                        setOperationError(
                          getSparsePresetOperationErrorMessage(
                            error,
                            'Failed to load sparse presets.'
                          )
                        )
                      }
                    })
                  }}
                >
                  <RefreshCcw />
                  {t('sparsePreset.retryLoad', 'Retry loading presets')}
                </Button>
              </div>
            ) : null}
          </div>
        ) : sortedPresets.length === 0 && !draft ? (
          <div className="py-4 text-sm text-muted-foreground">
            {t(
              'auto.components.settings.SparsePresetSettingsSection.88bfbf1a9c',
              'No sparse presets saved for this repository.'
            )}
          </div>
        ) : (
          <div>
            {sortedPresets.map((preset) =>
              draft?.presetId === preset.id ? (
                <div key={preset.id} data-settings-row="" className="py-3">
                  {draftEditor}
                </div>
              ) : (
                <SparsePresetSettingsRow
                  key={preset.id}
                  preset={preset}
                  confirmingDeleteId={confirmingDeleteId}
                  deletingPresetId={deletingPresetId}
                  submitting={submitting || !!draft}
                  onEdit={startEditPreset}
                  onDelete={handleDeletePreset}
                  onClearDeleteConfirm={() => setConfirmingDeleteId(null)}
                />
              )
            )}
          </div>
        )}
      </SettingsGroup>
    </section>
  )
}
