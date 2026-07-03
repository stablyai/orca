import { LoaderCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { SparsePresetDirectoryParseResult } from '@/lib/sparse-preset-draft'

export type SparsePresetDraft = {
  mode: 'new' | 'edit'
  presetId?: string
  name: string
  directoriesText: string
}

type SparseCheckoutPresetDraftFormProps = {
  draft: SparsePresetDraft
  parsedDirectories: SparsePresetDirectoryParseResult | null
  nameError: string | null
  submitting: boolean
  canSave: boolean
  setNameInputNode: (node: HTMLInputElement | null) => void
  onDraftChange: (draft: SparsePresetDraft) => void
  onCancel: () => void
  onSave: () => void
}

export function SparseCheckoutPresetDraftForm({
  draft,
  parsedDirectories,
  nameError,
  submitting,
  canSave,
  setNameInputNode,
  onDraftChange,
  onCancel,
  onSave
}: SparseCheckoutPresetDraftFormProps): React.JSX.Element {
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        onSave()
      }}
    >
      <div className="border-b border-border px-3 py-2 text-xs font-medium text-foreground">
        {draft.mode === 'new'
          ? translate('auto.components.sparse.SparseCheckoutPresetSelect.c4ac80151d', 'New preset')
          : translate(
              'auto.components.sparse.SparseCheckoutPresetSelect.69c020eddc',
              'Edit preset'
            )}
      </div>
      <div className="space-y-3 px-3 py-3">
        <div className="space-y-1">
          <label
            htmlFor="sparse-preset-name"
            className="block text-[11px] font-medium text-muted-foreground"
          >
            {translate('auto.components.sparse.SparseCheckoutPresetSelect.b3a500c623', 'Name')}
          </label>
          <div className="rounded-md border border-border/70 bg-muted/20 px-2.5 shadow-xs transition focus-within:border-ring/70 focus-within:ring-1 focus-within:ring-ring/30">
            <input
              id="sparse-preset-name"
              ref={setNameInputNode}
              value={draft.name}
              onChange={(event) => onDraftChange({ ...draft, name: event.target.value })}
              placeholder={translate(
                'auto.components.sparse.SparseCheckoutPresetSelect.064c1e2d12',
                'Renderer UI'
              )}
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
            {translate(
              'auto.components.sparse.SparseCheckoutPresetSelect.0e9ad9c798',
              'Directories'
            )}
          </label>
          <div className="rounded-md border border-border/70 bg-muted/20 px-2.5 py-1.5 shadow-xs transition focus-within:border-ring/70 focus-within:ring-1 focus-within:ring-ring/30">
            <textarea
              id="sparse-preset-directories"
              value={draft.directoriesText}
              onChange={(event) => onDraftChange({ ...draft, directoriesText: event.target.value })}
              placeholder={translate(
                'auto.components.sparse.SparseCheckoutPresetSelect.ddbcaef7be',
                'src/renderer packages/ui'
              )}
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
            translate('auto.components.sparse.SparseCheckoutPresetSelect.e9283eb171', '1 directory')
          ) : (
            translate(
              'auto.components.sparse.SparseCheckoutPresetSelect.14952d451e',
              '{{value0}} directories',
              { value0: parsedDirectories?.directories.length ?? 0 }
            )
          )}
        </div>
        <div className="flex shrink-0 justify-end gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs text-muted-foreground"
            onClick={onCancel}
            disabled={submitting}
          >
            {translate('auto.components.sparse.SparseCheckoutPresetSelect.de8fce5854', 'Cancel')}
          </Button>
          <Button type="submit" size="sm" className="h-7 px-2 text-xs" disabled={!canSave}>
            {submitting ? <LoaderCircle className="size-3 animate-spin" /> : null}
            {translate('auto.components.sparse.SparseCheckoutPresetSelect.8b12c0850a', 'Save')}
          </Button>
        </div>
      </div>
    </form>
  )
}
