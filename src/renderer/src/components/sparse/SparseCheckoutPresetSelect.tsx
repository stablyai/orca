import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronsUpDown, LoaderCircle, RefreshCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SparsePresetChooser } from './SparsePresetChooser'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useAppStore } from '@/store'
import { parseSparsePresetDirectories, validateSparsePresetName } from '@/lib/sparse-preset-draft'
import { useMountedRef } from '@/hooks/useMountedRef'
import type { SparsePreset } from '../../../../shared/worktree/create-types'
import { translate } from '@/i18n/i18n'
import type { SparsePresetDraft } from './SparseCheckoutPresetDraftForm'
import { SparsePresetInlineEditor } from './SparsePresetInlineEditor'

type SparseCheckoutPresetSelectProps = {
  repoId: string
  presets: SparsePreset[]
  selectedPresetId: string | null
  onSelectPreset: (preset: SparsePreset | null) => void
  disabled?: boolean
  onEditingChange?: (editing: boolean) => void
}

export default function SparseCheckoutPresetSelect({
  repoId,
  presets,
  selectedPresetId,
  onSelectPreset,
  disabled = false,
  onEditingChange
}: SparseCheckoutPresetSelectProps): React.JSX.Element {
  const repo = useAppStore((s) => s.repos.find((entry) => entry.id === repoId))
  const fetchSparsePresets = useAppStore((s) => s.fetchSparsePresets)
  const saveSparsePreset = useAppStore((s) => s.saveSparsePreset)
  const presetsForRepo = useAppStore((s) => s.sparsePresetsByRepo[repoId])
  const presetsLoadStatus = useAppStore((s) => s.sparsePresetsLoadStatusByRepo[repoId] ?? 'idle')
  const presetsLoading = presetsLoadStatus === 'loading'
  const presetsLoadError = useAppStore((s) => s.sparsePresetsErrorByRepo[repoId] ?? null)

  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<SparsePresetDraft | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [operationError, setOperationError] = useState<string | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const nameInputRef = useRef<HTMLInputElement>(null)
  const nameInputFocusFrameRef = useRef<number | null>(null)
  const mountedRef = useMountedRef()

  useEffect(() => () => onEditingChange?.(false), [onEditingChange])

  const finishDraft = useCallback(() => {
    setDraft(null)
    onEditingChange?.(false)
    triggerRef.current?.focus()
  }, [onEditingChange])

  const visiblePresets = presetsForRepo ?? presets
  const presetsLoaded = presetsForRepo !== undefined
  const isLoadingPresets = !disabled && presetsLoading
  const hasPresetLoadError = !disabled && !presetsLoaded && !!presetsLoadError
  const selectedPreset = useMemo(
    () => visiblePresets.find((preset) => preset.id === selectedPresetId) ?? null,
    [visiblePresets, selectedPresetId]
  )
  const parsedDirectories = draft ? parseSparsePresetDirectories(draft.directoriesText) : null
  const trimmedName = draft?.name.trim() ?? ''
  const nameError = draft
    ? validateSparsePresetName(draft.name, visiblePresets, draft.presetId)
    : null
  const canSave =
    draft !== null &&
    !submitting &&
    !disabled &&
    presetsLoaded &&
    !nameError &&
    parsedDirectories !== null &&
    !parsedDirectories.error

  const cancelNameInputFocusFrame = useCallback((): void => {
    if (nameInputFocusFrameRef.current === null) {
      return
    }
    cancelAnimationFrame(nameInputFocusFrameRef.current)
    nameInputFocusFrameRef.current = null
  }, [])

  const setNameInputNode = useCallback(
    (node: HTMLInputElement | null): void => {
      // Why: the queued draft focus is only valid while this input is mounted.
      if (!node) {
        cancelNameInputFocusFrame()
      }
      nameInputRef.current = node
    },
    [cancelNameInputFocusFrame]
  )

  const startDraft = useCallback(
    (nextDraft: SparsePresetDraft): void => {
      if (disabled || !presetsLoaded) {
        return
      }
      setOpen(false)
      setOperationError(null)
      setDraft(nextDraft)
      onEditingChange?.(true)
      cancelNameInputFocusFrame()
      nameInputFocusFrameRef.current = requestAnimationFrame(() => {
        nameInputFocusFrameRef.current = null
        nameInputRef.current?.focus()
        nameInputRef.current?.select()
        nameInputRef.current
          ?.closest('[data-sparse-preset-editor]')
          ?.scrollIntoView({ block: 'start' })
      })
    },
    [cancelNameInputFocusFrame, disabled, onEditingChange, presetsLoaded]
  )

  const startNewPreset = useCallback((): void => {
    startDraft({ mode: 'new', name: '', directoriesText: '' })
  }, [startDraft])

  const handleRetryLoadPresets = useCallback((): void => {
    if (disabled || presetsLoading) {
      return
    }
    setDraft(null)
    void fetchSparsePresets(repoId)
  }, [disabled, fetchSparsePresets, presetsLoading, repoId])

  const startEditPreset = useCallback(
    (preset: SparsePreset): void => {
      startDraft({
        mode: 'edit',
        presetId: preset.id,
        name: preset.name,
        directoriesText: preset.directories.join('\n')
      })
    },
    [startDraft]
  )

  const handleSaveDraft = useCallback(async (): Promise<void> => {
    if (!draft || !canSave || !parsedDirectories) {
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
        if (draft.mode === 'new' || selectedPresetId === saved.id) {
          onSelectPreset(saved)
        }
        finishDraft()
        setOpen(false)
      } else if (mountedRef.current) {
        setOperationError(
          translate('sparsePreset.saveFailed', 'Could not save the preset. Try again.')
        )
      }
    } catch {
      if (mountedRef.current) {
        setOperationError(
          translate('sparsePreset.saveFailed', 'Could not save the preset. Try again.')
        )
      }
    } finally {
      if (mountedRef.current) {
        setSubmitting(false)
      }
    }
  }, [
    canSave,
    draft,
    finishDraft,
    mountedRef,
    onSelectPreset,
    parsedDirectories,
    repoId,
    saveSparsePreset,
    selectedPresetId,
    trimmedName
  ])

  const handleSelectOff = useCallback((): void => {
    if (disabled || !presetsLoaded) {
      return
    }
    onSelectPreset(null)
    setDraft(null)
    setOpen(false)
  }, [disabled, onSelectPreset, presetsLoaded])

  const handleSelectPreset = useCallback(
    (preset: SparsePreset): void => {
      if (disabled || !presetsLoaded) {
        return
      }
      onSelectPreset(preset)
      setDraft(null)
      setOpen(false)
    },
    [disabled, onSelectPreset, presetsLoaded]
  )

  const triggerLabel = isLoadingPresets
    ? translate('sparsePreset.loading', 'Loading presets...')
    : hasPresetLoadError
      ? translate(
          'auto.components.sparse.SparseCheckoutPresetSelect.a683a4bc8e',
          'Retry loading presets'
        )
      : !presetsLoaded
        ? translate('auto.components.sparse.SparseCheckoutPresetSelect.16223dde6a', 'Load presets')
        : selectedPreset
          ? selectedPreset.name
          : translate('sparsePreset.fullCheckout', 'Full checkout')

  return (
    <>
      <Popover
        open={open}
        onOpenChange={(nextOpen) => {
          if (nextOpen && draft) {
            return
          }
          if (nextOpen && presetsLoading) {
            setOpen(false)
            setDraft(null)
            return
          }
          setOpen(nextOpen)
        }}
      >
        <PopoverTrigger asChild>
          <Button
            ref={triggerRef}
            type="button"
            variant="outline"
            role="combobox"
            aria-label={translate('sparsePreset.checkoutPreset', 'Checkout preset')}
            aria-expanded={open}
            aria-busy={isLoadingPresets}
            aria-disabled={Boolean(draft) || undefined}
            disabled={disabled || isLoadingPresets}
            className="w-full justify-between"
          >
            <span className="truncate">{triggerLabel}</span>
            {isLoadingPresets ? (
              <LoaderCircle className="size-3.5 animate-spin opacity-60" />
            ) : hasPresetLoadError || !presetsLoaded ? (
              <RefreshCcw className="size-3.5 opacity-60" />
            ) : (
              <ChevronsUpDown className="size-3.5 opacity-50" />
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          sideOffset={0}
          wheelScroll
          className="w-[var(--radix-popover-trigger-width)] max-w-[calc(100vw-2rem)]"
          onCloseAutoFocus={(event) => {
            if (draft) {
              event.preventDefault()
            }
          }}
        >
          {!presetsLoaded ? (
            <div className="p-1">
              {hasPresetLoadError ? (
                <div className="px-2 py-1.5 text-[11px] text-destructive">
                  <span className="break-words">{presetsLoadError}</span>
                </div>
              ) : null}
              <button
                type="button"
                className="flex h-9 w-full items-center gap-2 rounded-md px-2 text-left text-xs hover:bg-accent hover:text-accent-foreground"
                onClick={handleRetryLoadPresets}
              >
                <RefreshCcw className="size-3.5 text-muted-foreground" />
                <span className="truncate">
                  {hasPresetLoadError
                    ? translate(
                        'auto.components.sparse.SparseCheckoutPresetSelect.a683a4bc8e',
                        'Retry loading presets'
                      )
                    : translate(
                        'auto.components.sparse.SparseCheckoutPresetSelect.16223dde6a',
                        'Load presets'
                      )}
                </span>
              </button>
            </div>
          ) : (
            <SparsePresetChooser
              presets={visiblePresets}
              selectedPresetId={selectedPresetId}
              onSelect={handleSelectPreset}
              onSelectFull={handleSelectOff}
              onEdit={startEditPreset}
              onNew={startNewPreset}
            />
          )}
        </PopoverContent>
      </Popover>
      {draft ? (
        <SparsePresetInlineEditor
          draft={draft}
          parsedDirectories={parsedDirectories}
          nameError={nameError}
          submitting={submitting}
          canSave={canSave}
          setNameInputNode={setNameInputNode}
          onDraftChange={setDraft}
          onCancel={finishDraft}
          onSave={() => void handleSaveDraft()}
          operationError={operationError}
          repoRootPath={repo?.path}
          repoConnectionId={repo?.connectionId ?? undefined}
        />
      ) : null}
    </>
  )
}
