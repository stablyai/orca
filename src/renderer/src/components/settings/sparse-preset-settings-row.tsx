import { Bookmark, LoaderCircle, Pencil, Trash2 } from 'lucide-react'
import type { SparsePreset } from '../../../../shared/types'
import { cn } from '@/lib/utils'
import { Button } from '../ui/button'
import { formatSparsePresetUpdatedAt } from './sparse-preset-date'
import { SparsePresetDirectoryPreview } from './sparse-preset-directory-preview'
import { translate } from '@/i18n/i18n'

type SparsePresetSettingsRowProps = {
  preset: SparsePreset
  confirmingDeleteId: string | null
  deletingPresetId: string | null
  submitting: boolean
  onEdit: (preset: SparsePreset) => void
  onDelete: (preset: SparsePreset) => void
  onClearDeleteConfirm: () => void
}

export function SparsePresetSettingsRow({
  preset,
  confirmingDeleteId,
  deletingPresetId,
  submitting,
  onEdit,
  onDelete,
  onClearDeleteConfirm
}: SparsePresetSettingsRowProps): React.JSX.Element {
  // Why: users can already have locally persisted presets from older
  // builds or hand-edited state; a bad timestamp must not blank Settings.
  const updatedLabel = formatSparsePresetUpdatedAt(preset.updatedAt)
  const isDeleting = deletingPresetId === preset.id

  return (
    <div className="rounded-xl border border-border/50 bg-background/70 px-4 py-3 shadow-sm">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/50 bg-muted/30">
          <Bookmark className="size-4 text-muted-foreground" />
        </div>
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h4 className="min-w-0 truncate text-sm font-medium">{preset.name}</h4>
            <span className="text-[11px] text-muted-foreground">
              {preset.directories.length === 1
                ? translate(
                    'auto.components.settings.SparsePresetSettingsSection.9d3c087fc0',
                    '1 directory'
                  )
                : translate(
                    'auto.components.settings.SparsePresetSettingsSection.d7b3f0bdc3',
                    '{{value0}} directories',
                    { value0: preset.directories.length }
                  )}
            </span>
            <span className="text-[11px] text-muted-foreground">
              {updatedLabel
                ? translate(
                    'auto.components.settings.SparsePresetSettingsSection.568d7e1e49',
                    'Updated {{value0}}',
                    { value0: updatedLabel }
                  )
                : translate(
                    'auto.components.settings.SparsePresetSettingsSection.ba9ad2d4cd',
                    'Updated date unknown'
                  )}
            </span>
          </div>
          <SparsePresetDirectoryPreview directories={preset.directories} />
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={translate(
              'auto.components.settings.SparsePresetSettingsSection.fe1f2c6572',
              'Edit {{value0}}',
              { value0: preset.name }
            )}
            onClick={() => onEdit(preset)}
            disabled={submitting || deletingPresetId !== null}
          >
            <Pencil className="size-3.5" />
          </Button>
          <Button
            type="button"
            variant={confirmingDeleteId === preset.id ? 'destructive' : 'ghost'}
            size="sm"
            aria-label={translate(
              'auto.components.settings.SparsePresetSettingsSection.2ef2b2674b',
              'Delete {{value0}}',
              { value0: preset.name }
            )}
            onClick={() => void onDelete(preset)}
            onBlur={onClearDeleteConfirm}
            disabled={submitting || deletingPresetId !== null}
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
              ? translate(
                  'auto.components.settings.SparsePresetSettingsSection.a7bcf206b1',
                  'Deleting'
                )
              : confirmingDeleteId === preset.id
                ? translate(
                    'auto.components.settings.SparsePresetSettingsSection.755c6a1a0d',
                    'Confirm'
                  )
                : translate(
                    'auto.components.settings.SparsePresetSettingsSection.6fa754d20f',
                    'Delete'
                  )}
          </Button>
        </div>
      </div>
    </div>
  )
}
