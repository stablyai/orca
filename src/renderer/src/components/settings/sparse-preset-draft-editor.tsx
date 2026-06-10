import { LoaderCircle, Save, X } from 'lucide-react'
import type { SparsePresetDirectoryParseResult } from '@/lib/sparse-preset-draft'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { translate } from '@/i18n/i18n'

export type SparsePresetDraft = {
  mode: 'new' | 'edit'
  presetId?: string
  name: string
  directoriesText: string
}

type SparsePresetDraftEditorProps = {
  draft: SparsePresetDraft
  setDraft: (draft: SparsePresetDraft | null) => void
  nameError: string | null
  parsedDirectories: SparsePresetDirectoryParseResult | null
  canSaveDraft: boolean
  submitting: boolean
  onSave: () => void
}

export function SparsePresetDraftEditor({
  draft,
  setDraft,
  nameError,
  parsedDirectories,
  canSaveDraft,
  submitting,
  onSave
}: SparsePresetDraftEditorProps): React.JSX.Element {
  return (
    <div className="rounded-xl border border-border/60 bg-background/80 p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="space-y-0.5">
          <h5 className="text-sm font-semibold">
            {draft.mode === 'new'
              ? translate(
                  'auto.components.settings.SparsePresetSettingsSection.d7565029a9',
                  'New Preset'
                )
              : translate(
                  'auto.components.settings.SparsePresetSettingsSection.623b4cf910',
                  'Edit Preset'
                )}
          </h5>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.SparsePresetSettingsSection.694cc55ecb',
              'Saved directories are used when creating sparse worktrees for this repository.'
            )}
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={translate(
            'auto.components.settings.SparsePresetSettingsSection.b9922ec194',
            'Cancel preset edit'
          )}
          onClick={() => setDraft(null)}
          disabled={submitting}
        >
          <X className="size-3.5" />
        </Button>
      </div>

      <div className="grid gap-4 md:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
        <div className="space-y-2">
          <Label htmlFor="sparse-preset-settings-name">
            {translate('auto.components.settings.SparsePresetSettingsSection.a6fcdd9e3c', 'Name')}
          </Label>
          <Input
            id="sparse-preset-settings-name"
            value={draft.name}
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            placeholder={translate(
              'auto.components.settings.SparsePresetSettingsSection.3b6f1abd3e',
              'e.g. web-only'
            )}
            maxLength={80}
            autoComplete="off"
            spellCheck={false}
            className="h-9 text-sm"
          />
          {nameError ? <p className="text-xs text-destructive">{nameError}</p> : null}
        </div>

        <div className="space-y-2">
          <Label htmlFor="sparse-preset-settings-directories">
            {translate(
              'auto.components.settings.SparsePresetSettingsSection.caf33029cc',
              'Directories'
            )}
          </Label>
          <textarea
            id="sparse-preset-settings-directories"
            value={draft.directoriesText}
            onChange={(event) => setDraft({ ...draft, directoriesText: event.target.value })}
            placeholder={translate(
              'auto.components.settings.SparsePresetSettingsSection.fde7ff2cc3',
              'packages/web shared/ui'
            )}
            rows={5}
            spellCheck={false}
            className="w-full min-w-0 resize-y rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs shadow-xs outline-none transition-[color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
          />
          {parsedDirectories?.error ? (
            <p className="text-xs text-destructive">{parsedDirectories.error}</p>
          ) : (
            <p className="text-xs text-muted-foreground">
              {parsedDirectories?.directories.length === 1
                ? translate(
                    'auto.components.settings.SparsePresetSettingsSection.b532b9c17d',
                    '1 directory will be saved.'
                  )
                : translate(
                    'auto.components.settings.SparsePresetSettingsSection.3dfa765ca7',
                    '{{value0}} directories will be saved.',
                    { value0: parsedDirectories?.directories.length ?? 0 }
                  )}{' '}
              {translate(
                'auto.components.settings.SparsePresetSettingsSection.c240a16f25',
                'Use repo-relative paths like packages/web or apps/api.'
              )}
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
          {translate('auto.components.settings.SparsePresetSettingsSection.2d7d45e991', 'Cancel')}
        </Button>
        <Button type="button" size="sm" onClick={onSave} disabled={!canSaveDraft}>
          {submitting ? (
            <LoaderCircle className="size-3.5 animate-spin" />
          ) : (
            <Save className="size-3.5" />
          )}
          {translate(
            'auto.components.settings.SparsePresetSettingsSection.a05bc9183f',
            'Save Preset'
          )}
        </Button>
      </div>
    </div>
  )
}
