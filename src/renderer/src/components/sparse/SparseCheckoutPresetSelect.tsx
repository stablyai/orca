import React, { useCallback, useMemo, useRef, useState } from 'react'
import { Check, ChevronsUpDown, LoaderCircle, Pencil, Plus, RefreshCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'
import { parseSparsePresetDirectories } from '@/lib/sparse-preset-draft'
import type { SparsePreset } from '../../../../shared/types'

type SparseCheckoutPresetSelectProps = {
  repoId: string
  presets: SparsePreset[]
  selectedPresetId: string | null
  onSelectPreset: (preset: SparsePreset | null) => void
  disabled?: boolean
}

type PresetDraft = {
  mode: 'new' | 'edit'
  presetId?: string
  name: string
  directoriesText: string
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
  const [draft, setDraft] = useState<PresetDraft | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const nameInputRef = useRef<HTMLInputElement>(null)

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

  const startDraft = useCallback(
    (nextDraft: PresetDraft): void => {
      if (disabled || !presetsLoaded) {
        return
      }
      setDraft(nextDraft)
      requestAnimationFrame(() => {
        nameInputRef.current?.focus()
        nameInputRef.current?.select()
      })
    },
    [disabled, presetsLoaded]
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
      if (saved) {
        if (draft.mode === 'new' || selectedPresetId === saved.id) {
          onSelectPreset(saved)
        }
        setDraft(null)
        setOpen(false)
      }
    } finally {
      setSubmitting(false)
    }
  }, [
    canSave,
    draft,
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
          className="h-9 w-full justify-between px-3 text-sm font-normal text-foreground"
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
        className="w-[var(--radix-popover-trigger-width)] max-w-[calc(100vw-2rem)] p-0"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        {draft ? (
          <form
            onSubmit={(event) => {
              event.preventDefault()
              void handleSaveDraft()
            }}
          >
            <div className="border-b border-border px-3 py-2 text-xs font-medium text-foreground">
              {draft.mode === 'new' ? 'New preset' : 'Edit preset'}
            </div>
            <div className="space-y-3 px-3 py-3">
              <div className="space-y-1">
                <label
                  htmlFor="sparse-preset-name"
                  className="block text-[11px] font-medium text-muted-foreground"
                >
                  Name
                </label>
                <div className="rounded-md border border-border/70 bg-muted/20 px-2.5 shadow-xs transition focus-within:border-ring/70 focus-within:ring-1 focus-within:ring-ring/30">
                  <input
                    id="sparse-preset-name"
                    ref={nameInputRef}
                    value={draft.name}
                    onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                    placeholder="Renderer UI"
                    maxLength={80}
                    autoComplete="off"
                    spellCheck={false}
                    className="h-8 w-full bg-transparent text-xs text-foreground outline-none selection:bg-primary selection:text-primary-foreground placeholder:text-muted-foreground"
                  />
                </div>
              </div>
              <div className="space-y-1">
                <label
                  htmlFor="sparse-preset-directories"
                  className="block text-[11px] font-medium text-muted-foreground"
                >
                  Directories
                </label>
                <div className="rounded-md border border-border/70 bg-muted/20 px-2.5 py-1.5 shadow-xs transition focus-within:border-ring/70 focus-within:ring-1 focus-within:ring-ring/30">
                  <textarea
                    id="sparse-preset-directories"
                    value={draft.directoriesText}
                    onChange={(event) =>
                      setDraft({ ...draft, directoriesText: event.target.value })
                    }
                    placeholder={`src/renderer\npackages/ui`}
                    rows={3}
                    spellCheck={false}
                    className="max-h-28 w-full min-w-0 resize-none bg-transparent font-mono text-xs leading-5 text-foreground outline-none selection:bg-primary selection:text-primary-foreground placeholder:text-muted-foreground"
                  />
                </div>
              </div>
            </div>
            <div className="flex min-h-11 items-center justify-between gap-3 border-t border-border px-3 py-2">
              <div className="min-w-0 text-[10px] text-muted-foreground">
                {nameError ? (
                  <span className="text-destructive">{nameError}</span>
                ) : parsedDirectories?.error ? (
                  <span className="text-destructive">{parsedDirectories.error}</span>
                ) : parsedDirectories?.directories.length === 1 ? (
                  '1 directory'
                ) : (
                  `${parsedDirectories?.directories.length ?? 0} directories`
                )}
              </div>
              <div className="flex shrink-0 justify-end gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs text-muted-foreground"
                  onClick={() => setDraft(null)}
                  disabled={submitting}
                >
                  Cancel
                </Button>
                <Button type="submit" size="sm" className="h-7 px-2 text-xs" disabled={!canSave}>
                  {submitting ? <LoaderCircle className="size-3 animate-spin" /> : null}
                  Save
                </Button>
              </div>
            </div>
          </form>
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
                {hasPresetLoadError ? 'Retry loading presets' : 'Load presets'}
              </span>
            </button>
          </div>
        ) : (
          <div>
            <div className="py-1">
              <button
                type="button"
                className="mx-1 flex h-9 w-[calc(100%-0.5rem)] items-center gap-2 rounded-md px-2 text-left text-xs hover:bg-accent hover:text-accent-foreground"
                onClick={handleSelectOff}
              >
                <Check className={cn('size-4', selectedPreset ? 'opacity-0' : 'opacity-100')} />
                Off
              </button>
            </div>
            {visiblePresets.length > 0 ? (
              <>
                <div className="h-px bg-border" />
                <div className="space-y-0.5 py-1">
                  {visiblePresets.map((preset) => (
                    <div
                      key={preset.id}
                      className="mx-1 flex items-center rounded-md hover:bg-accent hover:text-accent-foreground"
                    >
                      <button
                        type="button"
                        className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-l-md px-2 text-left text-xs"
                        onClick={() => handleSelectPreset(preset)}
                      >
                        <Check
                          className={cn(
                            'size-4 shrink-0',
                            selectedPreset?.id === preset.id ? 'opacity-100' : 'opacity-0'
                          )}
                        />
                        <span className="truncate">{preset.name}</span>
                      </button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`Edit ${preset.name}`}
                        className="mr-1 size-7 shrink-0 rounded-md text-muted-foreground hover:bg-background/35 hover:text-foreground"
                        onClick={() => startEditPreset(preset)}
                      >
                        <Pencil className="size-3.5" />
                      </Button>
                    </div>
                  ))}
                </div>
              </>
            ) : null}
            <div className="border-t border-border">
              <Button
                type="button"
                variant="ghost"
                onClick={startNewPreset}
                className="mx-1 my-1 h-8 w-[calc(100%-0.5rem)] justify-start rounded-md px-2 text-xs font-normal"
              >
                <Plus className="size-3.5 text-muted-foreground" />
                New preset
              </Button>
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
