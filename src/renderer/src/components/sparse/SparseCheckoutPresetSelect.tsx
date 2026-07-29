import React, { useCallback, useMemo, useRef, useState } from 'react'
import { Check, ChevronsUpDown, LoaderCircle, Pencil, Plus, RefreshCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Command, CommandItem, CommandList, CommandSeparator } from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'
import { parseSparsePresetDirectories } from '@/lib/sparse-preset-draft'
import { useMountedRef } from '@/hooks/useMountedRef'
import type { SparsePreset } from '../../../../shared/types'
import { translate } from '@/i18n/i18n'
import {
  SparseCheckoutPresetDraftForm,
  type SparsePresetDraft
} from './SparseCheckoutPresetDraftForm'

type SparseCheckoutPresetSelectProps = {
  repoId: string
  presets: SparsePreset[]
  selectedPresetId: string | null
  onSelectPreset: (preset: SparsePreset | null) => void
  disabled?: boolean
}

export default function SparseCheckoutPresetSelect({
  repoId,
  presets,
  selectedPresetId,
  onSelectPreset,
  disabled = false
}: SparseCheckoutPresetSelectProps): React.JSX.Element {
  const fetchSparsePresets = useAppStore((s) => s.fetchSparsePresets)
  const saveSparsePreset = useAppStore((s) => s.saveSparsePreset)
  const presetsForRepo = useAppStore((s) => s.sparsePresetsByRepo[repoId])
  const presetsLoadStatus = useAppStore((s) => s.sparsePresetsLoadStatusByRepo[repoId] ?? 'idle')
  const presetsLoading = presetsLoadStatus === 'loading'
  const presetsLoadError = useAppStore((s) => s.sparsePresetsErrorByRepo[repoId] ?? null)

  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<SparsePresetDraft | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const nameInputRef = useRef<HTMLInputElement>(null)
  const nameInputFocusFrameRef = useRef<number | null>(null)
  const mountedRef = useMountedRef()

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
  const nameCollision =
    draft && trimmedName
      ? (visiblePresets.find(
          (preset) =>
            preset.id !== draft.presetId && preset.name.toLowerCase() === trimmedName.toLowerCase()
        ) ?? null)
      : null
  const nameError =
    draft && trimmedName.length === 0
      ? 'Name is required.'
      : trimmedName.length > 80
        ? 'Name must be 80 characters or fewer.'
        : nameCollision
          ? `"${nameCollision.name}" already exists.`
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
      setDraft(nextDraft)
      cancelNameInputFocusFrame()
      nameInputFocusFrameRef.current = requestAnimationFrame(() => {
        nameInputFocusFrameRef.current = null
        nameInputRef.current?.focus()
        nameInputRef.current?.select()
      })
    },
    [cancelNameInputFocusFrame, disabled, presetsLoaded]
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
        setDraft(null)
        setOpen(false)
      }
    } finally {
      if (mountedRef.current) {
        setSubmitting(false)
      }
    }
  }, [
    canSave,
    draft,
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
    ? 'Loading presets...'
    : hasPresetLoadError
      ? 'Retry loading presets'
      : !presetsLoaded
        ? 'Load presets'
        : selectedPreset
          ? selectedPreset.name
          : 'Off'

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen && presetsLoading) {
          setOpen(false)
          setDraft(null)
          return
        }
        setOpen(nextOpen)
        if (!nextOpen) {
          setDraft(null)
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-busy={isLoadingPresets}
          disabled={disabled || isLoadingPresets}
          className="h-9 w-full justify-between border-input px-3 text-sm font-normal text-foreground focus:border-ring focus:ring-[3px] focus:ring-ring/50"
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
        className="popover-scroll-content max-h-[min(var(--radix-popover-content-available-height),24rem)] w-[var(--radix-popover-trigger-width)] max-w-[calc(100vw-2rem)] overflow-y-auto p-0 scrollbar-sleek"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        {draft ? (
          <SparseCheckoutPresetDraftForm
            draft={draft}
            parsedDirectories={parsedDirectories}
            nameError={nameError}
            submitting={submitting}
            canSave={canSave}
            setNameInputNode={setNameInputNode}
            onDraftChange={setDraft}
            onCancel={() => setDraft(null)}
            onSave={() => void handleSaveDraft()}
          />
        ) : !presetsLoaded ? (
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
          // Why: cmdk Command/CommandItem so this dropdown matches the other composer pickers
          // (run-target, project, agent) — same padding, keyboard-highlight, and check placement.
          <Command value={selectedPreset ? `preset:${selectedPreset.id}` : 'off'}>
            <CommandList>
              <CommandItem
                value="off"
                onSelect={handleSelectOff}
                className="items-center gap-2 px-3 py-2"
              >
                <Check className={cn('size-4', selectedPreset ? 'opacity-0' : 'opacity-100')} />
                <span className="truncate">
                  {translate('auto.components.sparse.SparseCheckoutPresetSelect.c7f9b3f0c1', 'Off')}
                </span>
              </CommandItem>
              {visiblePresets.length > 0 ? (
                <>
                  <CommandSeparator />
                  {visiblePresets.map((preset) => (
                    <CommandItem
                      key={preset.id}
                      value={`preset:${preset.id}`}
                      onSelect={() => handleSelectPreset(preset)}
                      className="items-center gap-2 px-3 py-2"
                    >
                      <Check
                        className={cn(
                          'size-4 shrink-0',
                          selectedPreset?.id === preset.id ? 'opacity-100' : 'opacity-0'
                        )}
                      />
                      <span className="min-w-0 flex-1 truncate">{preset.name}</span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        aria-label={translate(
                          'auto.components.sparse.SparseCheckoutPresetSelect.7c3275d307',
                          'Edit {{value0}}',
                          { value0: preset.name }
                        )}
                        className="ml-1 size-6 shrink-0 rounded-md text-muted-foreground hover:bg-background/35 hover:text-foreground"
                        // Why: the pencil opens the edit draft; stop the event so cmdk doesn't
                        // also select the preset row underneath it.
                        onPointerDown={(event) => {
                          event.preventDefault()
                          event.stopPropagation()
                        }}
                        onClick={(event) => {
                          event.preventDefault()
                          event.stopPropagation()
                          startEditPreset(preset)
                        }}
                      >
                        <Pencil className="size-3.5" />
                      </Button>
                    </CommandItem>
                  ))}
                </>
              ) : null}
              <CommandSeparator />
              <CommandItem
                value="new-preset"
                onSelect={startNewPreset}
                className="items-center gap-2 px-3 py-2 text-muted-foreground"
              >
                <Plus className="size-4 shrink-0" />
                <span className="truncate">
                  {translate(
                    'auto.components.sparse.SparseCheckoutPresetSelect.c4ac80151d',
                    'New preset'
                  )}
                </span>
              </CommandItem>
            </CommandList>
          </Command>
        )}
      </PopoverContent>
    </Popover>
  )
}
