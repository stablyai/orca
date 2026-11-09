import React, { useState } from 'react'
import { Download, LoaderCircle } from 'lucide-react'
import { Trans } from 'react-i18next'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { i18n } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { isSetupScriptCollapsible, SetupScriptCodeBlock } from './SetupScriptCodeBlock'

export type SetupScriptReviewDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  repoDisplayName: string
  setup: string
  archive: string | null
  skippedFields: readonly string[]
  provenance: string | null
  isSaving: boolean
  onSave: () => void
}

function SkippedFieldsList({ fields }: { fields: readonly string[] }): React.JSX.Element {
  const t = useTranslate()
  return (
    <section className="min-w-0 text-xs text-muted-foreground">
      <h3 className="mb-0.5 font-medium text-foreground">
        {t('auto.components.sidebar.SetupScriptReviewDialog.notImported', 'Not imported')}
      </h3>
      <p className="mb-1.5">
        {t(
          'auto.components.sidebar.SetupScriptReviewDialog.notImportedHint',
          "These settings have no Orca equivalent and won't be saved."
        )}
      </p>
      <ul className="flex max-h-24 flex-wrap gap-1 overflow-y-auto scrollbar-sleek">
        {fields.map((field) => (
          <li key={field} className="max-w-full">
            <code className="block truncate rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground">
              {field}
            </code>
          </li>
        ))}
      </ul>
    </section>
  )
}

export function SetupScriptReviewDialog({
  open,
  onOpenChange,
  repoDisplayName,
  setup,
  archive,
  skippedFields,
  provenance,
  isSaving,
  onSave
}: SetupScriptReviewDialogProps): React.JSX.Element {
  const t = useTranslate()
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent scrollable className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle size="compact">
            {t('auto.components.sidebar.SetupScriptReviewDialog.title', 'Review setup script')}
          </DialogTitle>
          <DialogDescription size="compact">
            {provenance ? (
              <Trans
                i18n={i18n}
                defaults={t(
                  'auto.components.sidebar.SetupScriptReviewDialog.descriptionWithSource',
                  'From <file>{{source}}</file>. Saving runs this whenever Orca creates a worktree for {{repo}}.'
                )}
                values={{ source: provenance, repo: repoDisplayName }}
                components={{ file: <code className="font-mono text-foreground" /> }}
              />
            ) : (
              t(
                'auto.components.sidebar.SetupScriptReviewDialog.description',
                'Saving runs this whenever Orca creates a worktree for {{repo}}.',
                { repo: repoDisplayName }
              )
            )}
          </DialogDescription>
        </DialogHeader>

        <ReviewedScripts
          // A re-inspected candidate is new text, so it must be revealed again.
          key={`${setup}\0${archive ?? ''}`}
          setup={setup}
          archive={archive}
          skippedFields={skippedFields}
          isSaving={isSaving}
          onCancel={() => onOpenChange(false)}
          onSave={onSave}
        />
      </DialogContent>
    </Dialog>
  )
}

// Lives inside DialogContent, which unmounts on close, so every opening starts unrevealed.
function ReviewedScripts({
  setup,
  archive,
  skippedFields,
  isSaving,
  onCancel,
  onSave
}: {
  setup: string
  archive: string | null
  skippedFields: readonly string[]
  isSaving: boolean
  onCancel: () => void
  onSave: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const [setupRevealed, setSetupRevealed] = useState(false)
  const [archiveRevealed, setArchiveRevealed] = useState(false)
  // Imported scripts are saved verbatim, so Save waits until every collapsed line has been shown.
  const fullyShown =
    (setupRevealed || !isSetupScriptCollapsible(setup)) &&
    (archive === null || archiveRevealed || !isSetupScriptCollapsible(archive))
  return (
    <>
      <SetupScriptCodeBlock
        heading={t('auto.components.sidebar.SetupScriptReviewDialog.setupScript', 'Setup script')}
        script={setup}
        onExpand={() => setSetupRevealed(true)}
      />
      {archive ? (
        <SetupScriptCodeBlock
          heading={t(
            'auto.components.sidebar.SetupScriptReviewDialog.archiveScript',
            'Archive script'
          )}
          script={archive}
          onExpand={() => setArchiveRevealed(true)}
        />
      ) : null}

      {skippedFields.length > 0 ? <SkippedFieldsList fields={skippedFields} /> : null}

      <DialogFooter className="sm:items-center">
        {fullyShown ? null : (
          <p className="text-xs text-muted-foreground sm:mr-auto">
            {t(
              'auto.components.sidebar.SetupScriptReviewDialog.showFullToSave',
              'Show the full script to save it.'
            )}
          </p>
        )}
        <Button variant="outline" onClick={onCancel}>
          {t('common.cancel', 'Cancel')}
        </Button>
        <Button onClick={onSave} disabled={isSaving || !fullyShown}>
          {isSaving ? (
            <LoaderCircle className="size-3.5 animate-spin" />
          ) : (
            <Download className="size-3.5" />
          )}
          <span className={cn(isSaving && 'text-muted-foreground')}>
            {t('auto.components.sidebar.SetupScriptReviewDialog.save', 'Save local setup')}
          </span>
        </Button>
      </DialogFooter>
    </>
  )
}
