import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Bookmark, Check, ChevronsUpDown, Pencil, RefreshCw, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'
import type { SparsePreset } from '../../../../shared/types'
import { sparseDirectoriesMatch } from '@/lib/sparse-paths'
import InlineNameEditor from './InlineNameEditor'

type SparsePresetPickerProps = {
  repoId: string
  presets: SparsePreset[]
  /** Repo-relative directories currently in the textarea (already normalized
   *  by the parent). Used to detect "Custom" vs "matches preset X" state. */
  directories: string[]
  /** When set, the user explicitly picked this preset; the trigger label
   *  shows its name. Cleared by the parent when the user picks "Custom". */
  selectedPresetId: string | null
  onSelectPreset: (preset: SparsePreset | null) => void
  /** True when the textarea has at least one valid directory; gates the
   *  "Replace with current" context-menu action. */
  canSaveCurrent: boolean
}

/** Combobox-shaped picker for saved sparse presets, modeled after the
 *  existing `RepoCombobox`/`AgentCombobox` patterns. The picker is a pure
 *  selector — saving a new preset lives in `SparsePresetSaveButton` next to
 *  it, so each control does exactly one thing. Right-clicking a row opens
 *  rename/replace/delete actions; rename uses inline editing inside the
 *  popover (the file-tree pattern, universally understood). */
export default function SparsePresetPicker({
  repoId,
  presets,
  directories,
  selectedPresetId,
  onSelectPreset,
  canSaveCurrent
}: SparsePresetPickerProps): React.JSX.Element {
  const removeSparsePreset = useAppStore((s) => s.removeSparsePreset)
  const saveSparsePreset = useAppStore((s) => s.saveSparsePreset)

  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (renamingId) {
      requestAnimationFrame(() => {
        inputRef.current?.focus()
        inputRef.current?.select()
      })
    }
  }, [renamingId])

  // Why: discard any in-flight rename when the popover closes — re-opening
  // shouldn't surface a stale input on a row the user already moved past.
  useEffect(() => {
    if (!open) {
      setRenamingId(null)
      setRenameDraft('')
      setSearch('')
    }
  }, [open])

  const matchedPreset = useMemo(() => {
    if (directories.length === 0) {
      return null
    }
    return presets.find((preset) => sparseDirectoriesMatch(preset.directories, directories)) ?? null
  }, [directories, presets])

  const selectedPreset = useMemo(
    () => presets.find((preset) => preset.id === selectedPresetId) ?? null,
    [presets, selectedPresetId]
  )

  // Why: trigger label reflects what the textarea actually contains, not what
  // the user originally clicked. Once they edit past a preset, the trigger
  // flips to "Custom directories" + an "edited" tag so the resulting worktree
  // never gets misattributed in the worktree card tooltip.
  const triggerLabel = matchedPreset?.name ?? 'Custom directories'
  const isModified = selectedPreset !== null && matchedPreset?.id !== selectedPreset.id

  const filteredPresets = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) {
      return presets
    }
    return presets.filter((preset) => preset.name.toLowerCase().includes(query))
  }, [presets, search])

  const handleSelectCustom = useCallback(() => {
    onSelectPreset(null)
    setOpen(false)
  }, [onSelectPreset])

  const handleSelectPreset = useCallback(
    (preset: SparsePreset) => {
      onSelectPreset(preset)
      setOpen(false)
    },
    [onSelectPreset]
  )

  const startRename = useCallback((preset: SparsePreset) => {
    setRenamingId(preset.id)
    setRenameDraft(preset.name)
  }, [])

  const cancelRename = useCallback(() => {
    setRenamingId(null)
    setRenameDraft('')
  }, [])

  const renamingTarget = useMemo(
    () => (renamingId ? (presets.find((preset) => preset.id === renamingId) ?? null) : null),
    [presets, renamingId]
  )

  const trimmedRename = renameDraft.trim()
  const collidingRenamePreset = useMemo(() => {
    if (!trimmedRename || !renamingId) {
      return null
    }
    const lower = trimmedRename.toLowerCase()
    return (
      presets.find((preset) => preset.id !== renamingId && preset.name.toLowerCase() === lower) ??
      null
    )
  }, [presets, renamingId, trimmedRename])

  const renameUnchanged = renamingTarget !== null && trimmedRename === renamingTarget.name.trim()
  const canCommitRename =
    !!renamingTarget &&
    trimmedRename.length > 0 &&
    trimmedRename.length <= 80 &&
    !collidingRenamePreset &&
    !renameUnchanged

  const commitRename = useCallback(async () => {
    if (!renamingTarget || !canCommitRename || submitting) {
      return
    }
    setSubmitting(true)
    try {
      const saved = await saveSparsePreset({
        repoId,
        id: renamingTarget.id,
        name: trimmedRename,
        directories: renamingTarget.directories
      })
      if (saved) {
        cancelRename()
      }
    } finally {
      setSubmitting(false)
    }
  }, [
    canCommitRename,
    cancelRename,
    renamingTarget,
    repoId,
    saveSparsePreset,
    submitting,
    trimmedRename
  ])

  const handleReplace = useCallback(
    async (preset: SparsePreset) => {
      // Why: "Replace with current" overwrites a preset's directories with the
      // textarea content. The right-click target makes the user's intent
      // unambiguous, so no name input is needed — keep the existing name.
      const saved = await saveSparsePreset({
        repoId,
        id: preset.id,
        name: preset.name,
        directories
      })
      if (saved) {
        onSelectPreset(saved)
        setOpen(false)
      }
    },
    [directories, onSelectPreset, repoId, saveSparsePreset]
  )

  const handleDelete = useCallback(
    async (preset: SparsePreset) => {
      // Why: clear the active selection first so the trigger doesn't show a
      // stale preset name during the optimistic delete.
      if (selectedPresetId === preset.id) {
        onSelectPreset(null)
      }
      await removeSparsePreset({ repoId, presetId: preset.id })
    },
    [onSelectPreset, removeSparsePreset, repoId, selectedPresetId]
  )

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="h-8 flex-1 justify-between px-2.5 text-xs font-normal text-foreground"
        >
          <span className="inline-flex min-w-0 items-center gap-1.5">
            <Bookmark
              className={cn(
                'size-3.5 shrink-0',
                matchedPreset ? 'text-foreground' : 'text-muted-foreground/70'
              )}
            />
            <span className="truncate">{triggerLabel}</span>
            {isModified ? (
              <span className="shrink-0 rounded-sm border border-amber-500/30 bg-amber-500/10 px-1 py-0.5 text-[9px] font-medium uppercase tracking-wide leading-none text-amber-700 dark:text-amber-300">
                edited
              </span>
            ) : null}
          </span>
          <ChevronsUpDown className="size-3.5 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[var(--radix-popover-trigger-width)] min-w-[15rem] p-0"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <Command shouldFilter={false}>
          {presets.length > 4 && !renamingId ? (
            <CommandInput placeholder="Search presets…" value={search} onValueChange={setSearch} />
          ) : null}
          <CommandList>
            <CommandItem
              value="__custom__"
              onSelect={handleSelectCustom}
              className="items-center gap-2 px-3 py-1.5"
            >
              <Check
                className={cn(
                  'size-4 text-foreground',
                  matchedPreset === null ? 'opacity-100' : 'opacity-0'
                )}
              />
              <span className="text-xs">Custom directories</span>
            </CommandItem>
            {presets.length === 0 ? (
              <div className="px-3 py-2 text-[11px] text-muted-foreground">
                No saved presets yet. Use the bookmark button to save the current directories.
              </div>
            ) : null}
            {filteredPresets.length === 0 && presets.length > 0 && search ? (
              <CommandEmpty>No presets match.</CommandEmpty>
            ) : null}
            {filteredPresets.map((preset) => {
              if (renamingId === preset.id) {
                return (
                  <InlineNameEditor
                    key={preset.id}
                    inputRef={inputRef}
                    value={renameDraft}
                    onChange={setRenameDraft}
                    onCommit={() => void commitRename()}
                    onCancel={cancelRename}
                    submitting={submitting}
                    canCommit={canCommitRename}
                    collidingName={collidingRenamePreset?.name}
                  />
                )
              }
              const isMatched = matchedPreset?.id === preset.id
              const row = (
                <CommandItem
                  key={preset.id}
                  value={preset.id}
                  onSelect={() => handleSelectPreset(preset)}
                  className="items-center gap-2 px-3 py-1.5"
                >
                  <Check
                    className={cn(
                      'size-4 text-foreground',
                      isMatched ? 'opacity-100' : 'opacity-0'
                    )}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs">{preset.name}</div>
                    <div className="truncate text-[10px] text-muted-foreground">
                      {preset.directories.length === 1
                        ? '1 directory'
                        : `${preset.directories.length} directories`}
                    </div>
                  </div>
                </CommandItem>
              )
              return (
                <ContextMenu key={preset.id}>
                  <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
                  <ContextMenuContent className="z-[70]">
                    <ContextMenuItem onSelect={() => startRename(preset)}>
                      <Pencil className="size-3.5" />
                      Rename
                    </ContextMenuItem>
                    {canSaveCurrent ? (
                      <ContextMenuItem onSelect={() => void handleReplace(preset)}>
                        <RefreshCw className="size-3.5" />
                        Replace with current
                      </ContextMenuItem>
                    ) : null}
                    <ContextMenuSeparator />
                    <ContextMenuItem
                      variant="destructive"
                      onSelect={() => void handleDelete(preset)}
                    >
                      <Trash2 className="size-3.5" />
                      Delete
                    </ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
              )
            })}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
