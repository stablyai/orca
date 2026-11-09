import { useState } from 'react'
import { Checkbox } from '@/components/ui/checkbox'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { useTranslate } from '@/i18n/use-translate'
import type { RepoSetupImports } from './cloud-environment-types'
import { lineDiff } from './environment-draft'

export type ImportReview = {
  projectName: string
  imports: RepoSetupImports
}

/**
 * Review what "Import from repo" found before it touches the draft: new variable names are merged,
 * and the suggested install script is shown as a diff against the current one (opt-in replace).
 */
export function ImportFromRepoDialog({
  review,
  currentScript,
  currentEnvVarNames,
  onApply,
  onClose
}: {
  review: ImportReview | null
  currentScript: string
  currentEnvVarNames: readonly string[]
  onApply: (result: { envVarNames: string[]; installScript: string | null }) => void
  onClose: () => void
}): React.JSX.Element {
  return (
    <Dialog open={review !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      {review ? (
        <ImportReviewContent
          // Remount per review so the checkboxes start from this import's defaults.
          key={`${review.projectName}:${review.imports.sources.join('|')}`}
          review={review}
          currentScript={currentScript}
          currentEnvVarNames={currentEnvVarNames}
          onApply={onApply}
          onClose={onClose}
        />
      ) : null}
    </Dialog>
  )
}

function ImportReviewContent({
  review,
  currentScript,
  currentEnvVarNames,
  onApply,
  onClose
}: {
  review: ImportReview
  currentScript: string
  currentEnvVarNames: readonly string[]
  onApply: (result: { envVarNames: string[]; installScript: string | null }) => void
  onClose: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const newNames = review.imports.envVarNames.filter((name) => !currentEnvVarNames.includes(name))
  const suggested = review.imports.installScript?.trim() ? review.imports.installScript : null
  const scriptDiffers = suggested !== null && suggested.trim() !== currentScript.trim()
  const [takeNames, setTakeNames] = useState(newNames.length > 0)
  // Replacing a script someone wrote is opt-in; filling an empty one is the obvious default.
  const [takeScript, setTakeScript] = useState(scriptDiffers && currentScript.trim() === '')
  const nothing = newNames.length === 0 && !scriptDiffers
  const diff = scriptDiffers && suggested !== null ? lineDiff(currentScript, suggested) : []

  return (
    <DialogContent className="sm:max-w-2xl" scrollable>
      <DialogHeader>
        <DialogTitle>
          {t('cloudEnvironment.import.title', 'Import from {{project}}', {
            project: review.projectName
          })}
        </DialogTitle>
        <DialogDescription>
          {review.imports.sources.length > 0
            ? t('cloudEnvironment.import.sources', 'Found in {{sources}}.', {
                sources: review.imports.sources.join(', ')
              })
            : t('cloudEnvironment.import.noSources', 'No setup config was found in this project.')}
        </DialogDescription>
      </DialogHeader>

      {nothing ? (
        <p className="text-sm text-muted-foreground">
          {t(
            'cloudEnvironment.import.nothing',
            'Nothing new to import: the environment already has these settings.'
          )}
        </p>
      ) : (
        <div className="space-y-4">
          {newNames.length > 0 ? (
            <label className="flex items-start gap-2.5">
              <Checkbox
                checked={takeNames}
                onCheckedChange={(value) => setTakeNames(value === true)}
                className="mt-0.5"
              />
              <span className="min-w-0 space-y-1.5">
                <span className="block text-sm font-medium">
                  {t('cloudEnvironment.import.addNames', 'Add these variable names ({{total}})', {
                    total: String(newNames.length)
                  })}
                </span>
                <span className="flex flex-wrap gap-1">
                  {newNames.map((name) => (
                    <span
                      key={name}
                      className="rounded bg-secondary px-1.5 py-0.5 font-mono text-xs text-secondary-foreground"
                    >
                      {name}
                    </span>
                  ))}
                </span>
              </span>
            </label>
          ) : null}
          {scriptDiffers ? (
            <div className="space-y-2">
              <label className="flex items-start gap-2.5">
                <Checkbox
                  checked={takeScript}
                  onCheckedChange={(value) => setTakeScript(value === true)}
                  className="mt-0.5"
                />
                <span className="text-sm font-medium">
                  {currentScript.trim() === ''
                    ? t('cloudEnvironment.import.useScript', 'Use the suggested install script')
                    : t(
                        'cloudEnvironment.import.replaceScript',
                        'Replace the install script with the suggestion'
                      )}
                </span>
              </label>
              <pre
                aria-label={t('cloudEnvironment.import.diffAria', 'Install script changes')}
                className="max-h-72 overflow-auto rounded-md border border-border bg-muted/30 py-1.5 font-mono text-xs leading-5 scrollbar-editor dark:bg-black/20"
              >
                {diff.map((line, index) => (
                  <div
                    key={index}
                    className={cn(
                      'flex gap-2 px-3',
                      line.kind === 'add' && 'bg-status-success-background text-status-success',
                      line.kind === 'remove' &&
                        'bg-destructive/10 text-destructive line-through decoration-destructive/40'
                    )}
                  >
                    <span aria-hidden className="w-3 shrink-0 select-none">
                      {line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : ' '}
                    </span>
                    <span className="sr-only">
                      {line.kind === 'add'
                        ? t('cloudEnvironment.import.added', 'added: ')
                        : line.kind === 'remove'
                          ? t('cloudEnvironment.import.removed', 'removed: ')
                          : ''}
                    </span>
                    <span className="whitespace-pre">{line.text || ' '}</span>
                  </div>
                ))}
              </pre>
            </div>
          ) : null}
        </div>
      )}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          {t('cloudEnvironment.import.cancel', 'Cancel')}
        </Button>
        <Button
          type="button"
          disabled={nothing || (!takeNames && !takeScript)}
          onClick={() =>
            onApply({
              envVarNames: takeNames ? newNames : [],
              installScript: takeScript && suggested !== null ? suggested : null
            })
          }
        >
          {t('cloudEnvironment.import.apply', 'Apply to draft')}
        </Button>
      </DialogFooter>
    </DialogContent>
  )
}
