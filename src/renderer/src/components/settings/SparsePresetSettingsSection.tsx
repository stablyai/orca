import { useEffect, useState } from 'react'
import { Bookmark, LoaderCircle, Pencil, Plus, Save, Trash2, X } from 'lucide-react'
import type { SparsePreset } from '../../../../shared/types'
import { useAppStore } from '../../store'
import { cn } from '@/lib/utils'
import { parseSparsePresetDirectories } from '@/lib/sparse-preset-draft'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { formatSparsePresetUpdatedAt } from './sparse-preset-date'

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
          +{hiddenCount} more
        </span>
      ) : null}
    </div>
  )
}

export function SparsePresetSettingsSection({
  repoId
}: SparsePresetSettingsSectionProps): React.JSX.Element {
  const presets = useAppStore((s) => s.sparsePresetsByRepo[repoId])
  const fetchSparsePresets = useAppStore((s) => s.fetchSparsePresets)
  const saveSparsePreset = useAppStore((s) => s.saveSparsePreset)
  const removeSparsePreset = useAppStore((s) => s.removeSparsePreset)

  const [draft, setDraft] = useState<SparsePresetDraft | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null)

  useEffect(() => {
    if (presets === undefined) {
      void fetchSparsePresets(repoId)
    }
  }, [fetchSparsePresets, presets, repoId])

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

  const startNewPreset = (): void => {
    setConfirmingDeleteId(null)
    setDraft({
      mode: 'new',
      name: '',
      directoriesText: ''
    })
  }

  const startEditPreset = (preset: SparsePreset): void => {
    setConfirmingDeleteId(null)
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
    try {
      const saved = await saveSparsePreset({
        repoId,
        id: draft.presetId,
        name: trimmedName,
        directories: parsedDirectories.directories
      })
      if (saved) {
        setDraft(null)
      }
    } finally {
      setSubmitting(false)
    }
  }

  const handleDeletePreset = async (preset: SparsePreset): Promise<void> => {
    if (confirmingDeleteId !== preset.id) {
      setConfirmingDeleteId(preset.id)
      return
    }
    if (draft?.presetId === preset.id) {
      setDraft(null)
    }
    setConfirmingDeleteId(null)
    await removeSparsePreset({ repoId, presetId: preset.id })
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
              {draft.mode === 'new' ? 'New Preset' : 'Edit Preset'}
            </h5>
            <p className="text-xs text-muted-foreground">
              Saved directories are used when creating sparse worktrees for this repository.
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Cancel preset edit"
            onClick={() => setDraft(null)}
            disabled={submitting}
          >
            <X className="size-3.5" />
          </Button>
        </div>

        <div className="grid gap-4 md:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
          <div className="space-y-2">
            <Label htmlFor="sparse-preset-settings-name">Name</Label>
            <Input
              id="sparse-preset-settings-name"
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              placeholder="e.g. web-only"
              maxLength={80}
              autoComplete="off"
              spellCheck={false}
              className="h-9 text-sm"
            />
            {nameError ? <p className="text-xs text-destructive">{nameError}</p> : null}
          </div>

          <div className="space-y-2">
            <Label htmlFor="sparse-preset-settings-directories">Directories</Label>
            <textarea
              id="sparse-preset-settings-directories"
              value={draft.directoriesText}
              onChange={(event) => setDraft({ ...draft, directoriesText: event.target.value })}
              placeholder={`packages/web\nshared/ui`}
              rows={5}
              spellCheck={false}
              className="w-full min-w-0 resize-y rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs shadow-xs outline-none transition-[color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
            />
            {parsedDirectories?.error ? (
              <p className="text-xs text-destructive">{parsedDirectories.error}</p>
            ) : (
              <p className="text-xs text-muted-foreground">
                {parsedDirectories?.directories.length === 1
                  ? '1 directory will be saved.'
                  : `${parsedDirectories?.directories.length ?? 0} directories will be saved.`}{' '}
                Use repo-relative paths like packages/web or apps/api.
              </p>
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
            Cancel
          </Button>
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
            Save Preset
          </Button>
        </div>
      </div>
    )
  }

  return (
    <section className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold">Sparse Checkout Presets</h3>
          <p className="text-xs text-muted-foreground">
            Manage saved directory sets for sparse worktree creation.
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
          New Preset
        </Button>
      </div>

      {renderDraftEditor()}

      {presets === undefined ? (
        <div className="rounded-xl border border-dashed border-border/60 bg-background/60 px-4 py-6 text-sm text-muted-foreground">
          Loading sparse presets...
        </div>
      ) : sortedPresets.length === 0 && !draft ? (
        <div className="rounded-xl border border-dashed border-border/60 bg-background/60 px-4 py-6 text-sm text-muted-foreground">
          No sparse presets saved for this repository.
        </div>
      ) : (
        <div className="space-y-2">
          {sortedPresets.map((preset) => {
            // Why: users can already have locally persisted presets from older
            // builds or hand-edited state; a bad timestamp must not blank Settings.
            const updatedLabel = formatSparsePresetUpdatedAt(preset.updatedAt)

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
                          ? '1 directory'
                          : `${preset.directories.length} directories`}
                      </span>
                      <span className="text-[11px] text-muted-foreground">
                        {updatedLabel ? `Updated ${updatedLabel}` : 'Updated date unknown'}
                      </span>
                    </div>
                    <SparsePresetDirectoryPreview directories={preset.directories} />
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Edit ${preset.name}`}
                      onClick={() => startEditPreset(preset)}
                      disabled={submitting}
                    >
                      <Pencil className="size-3.5" />
                    </Button>
                    <Button
                      type="button"
                      variant={confirmingDeleteId === preset.id ? 'destructive' : 'ghost'}
                      size="sm"
                      aria-label={`Delete ${preset.name}`}
                      onClick={() => void handleDeletePreset(preset)}
                      onBlur={() => setConfirmingDeleteId(null)}
                      disabled={submitting}
                      className={cn(
                        'w-[5.75rem] px-2 text-xs',
                        confirmingDeleteId !== preset.id && 'text-muted-foreground'
                      )}
                    >
                      <Trash2 className="size-3.5" />
                      {confirmingDeleteId === preset.id ? 'Confirm' : 'Delete'}
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
