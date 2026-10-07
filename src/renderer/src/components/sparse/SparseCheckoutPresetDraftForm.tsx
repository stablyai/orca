import { useId, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SparseDirectoryPicker } from './SparseDirectoryPicker'
import { SparseSelectedDirectoryList } from './SparseSelectedDirectoryList'
import { addSparseDirectoryEntries } from './sparse-directory-entry-input'
import { translate } from '@/i18n/i18n'
import { normalizeSparseDirectoryLines } from '@/lib/sparse-paths'
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
  setNameInputNode?: (node: HTMLInputElement | null) => void
  onDraftChange: (draft: SparsePresetDraft) => void
  onCancel: () => void
  onSave: () => void
  operationError?: string | null
  repoRootPath?: string
  repoConnectionId?: string
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
  onSave,
  operationError,
  repoRootPath,
  repoConnectionId
}: SparseCheckoutPresetDraftFormProps): React.JSX.Element {
  const id = useId()
  const [nameTouched, setNameTouched] = useState(false)
  const visibleNameError = nameTouched || draft.name.length > 0 ? nameError : null
  const directoryError = draft.directoriesText.length > 0 ? parsedDirectories?.error : null
  // Why: chips must survive a preset whose saved paths no longer parse.
  const selectedDirectories = normalizeSparseDirectoryLines(draft.directoriesText)
  const setDirectories = (next: string[]): void => {
    onDraftChange({ ...draft, directoriesText: next.join('\n') })
  }
  const addDirectories = (directories: string[]): void => {
    setDirectories(addSparseDirectoryEntries(selectedDirectories, directories))
  }
  const removeDirectory = (directory: string): void => {
    setDirectories(selectedDirectories.filter((entry) => entry !== directory))
  }
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault()
        event.stopPropagation()
        onSave()
      }}
    >
      <div className="space-y-3">
        <div className="space-y-2">
          <Label htmlFor={`${id}-name`}>{translate('sparsePreset.name', 'Name')}</Label>
          <Input
            id={`${id}-name`}
            ref={setNameInputNode}
            value={draft.name}
            onChange={(event) => onDraftChange({ ...draft, name: event.target.value })}
            placeholder={translate('sparsePreset.namePlaceholder', 'Web app and shared UI')}
            disabled={submitting}
            autoComplete="off"
            spellCheck={false}
            onBlur={() => setNameTouched(true)}
            aria-invalid={!!visibleNameError}
            aria-describedby={visibleNameError ? `${id}-name-error` : undefined}
          />
          {visibleNameError ? (
            <p id={`${id}-name-error`} className="text-xs text-destructive">
              {visibleNameError}
            </p>
          ) : null}
        </div>
        <div className="space-y-2">
          <Label id={`${id}-directories`}>
            {translate('sparsePreset.directories', 'Directories')}
          </Label>
          <p id={`${id}-help`} className="text-xs text-muted-foreground">
            {translate(
              'sparsePreset.pathInstructions',
              'Pick folders from the repository, or type any repo-relative path.'
            )}
          </p>
          <SparseDirectoryPicker
            rootPath={repoRootPath ?? ''}
            connectionId={repoConnectionId}
            selected={selectedDirectories}
            disabled={submitting}
            describedById={`${id}-help ${id}-directory-status`}
            onAdd={addDirectories}
          />
          <SparseSelectedDirectoryList
            directories={selectedDirectories}
            disabled={submitting}
            onRemove={removeDirectory}
          />
          <p id={`${id}-directory-status`} aria-live="polite">
            {directoryError ? (
              <span className="text-xs text-destructive">{directoryError}</span>
            ) : null}
          </p>
        </div>
        <details className="space-y-2 text-xs text-muted-foreground">
          <summary className="cursor-pointer">
            {translate('sparsePreset.details', 'What gets checked out?')}
          </summary>
          <p>
            {translate(
              'sparsePreset.coneHelp',
              'Git also keeps files at the repository root and along the parent folders of these directories.'
            )}
          </p>
        </details>
      </div>
      <div className="space-y-3 border-t border-border pt-3">
        {operationError ? (
          <p role="alert" className="text-sm text-destructive">
            {operationError}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onCancel} disabled={submitting}>
            {translate('sparsePreset.cancel', 'Cancel')}
          </Button>
          <Button
            type="submit"
            disabled={!canSave}
            aria-busy={submitting}
            aria-label={translate('sparsePreset.save', 'Save preset')}
          >
            <span className="relative">
              <span className="data-[saving=true]:invisible" data-saving={submitting}>
                {translate('sparsePreset.save', 'Save preset')}
              </span>
              {submitting ? (
                <span className="absolute inset-0 flex items-center justify-center">
                  <Loader2 className="size-4 animate-spin" />
                </span>
              ) : null}
            </span>
          </Button>
        </div>
      </div>
    </form>
  )
}
