import React from 'react'
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
import { cn } from '@/lib/class-names'
import { i18n } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { SetupScriptCodeBlock } from './SetupScriptCodeBlock'

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
      {/* Viewport-capped column: only the middle scrolls, so the title and Save stay visible for any script length. */}
      <DialogContent className="flex max-h-[calc(100vh-2rem)] flex-col overflow-hidden sm:max-w-xl">
        <DialogHeader className="shrink-0">
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

        <div className="-mx-6 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto scrollbar-sleek px-6">
          <SetupScriptCodeBlock
            heading={t(
              'auto.components.sidebar.SetupScriptReviewDialog.setupScript',
              'Setup script'
            )}
            script={setup}
          />
          {archive ? (
            <SetupScriptCodeBlock
              heading={t(
                'auto.components.sidebar.SetupScriptReviewDialog.archiveScript',
                'Archive script'
              )}
              script={archive}
            />
          ) : null}

          {skippedFields.length > 0 ? <SkippedFieldsList fields={skippedFields} /> : null}
        </div>

        <DialogFooter className="shrink-0">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button onClick={onSave} disabled={isSaving}>
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
      </DialogContent>
    </Dialog>
  )
}
