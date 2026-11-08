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
import { cn } from '@/lib/utils'
import { i18n } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'

export type SetupScriptReviewDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  repoDisplayName: string
  setup: string
  archive: string | null
  provenance: string | null
  isSaving: boolean
  onSave: () => void
}

function ScriptBlock({ heading, script }: { heading: string; script: string }): React.JSX.Element {
  return (
    <section className="min-w-0 rounded-md border border-border/70 bg-muted/35 px-3 py-2">
      <h3 className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {heading}
      </h3>
      <pre
        tabIndex={0}
        aria-label={heading}
        className="max-h-[40vh] overflow-auto whitespace-pre-wrap break-all font-mono text-xs leading-5 text-foreground outline-none scrollbar-sleek focus-visible:ring-1 focus-visible:ring-ring"
      >
        {script}
      </pre>
    </section>
  )
}

export function SetupScriptReviewDialog({
  open,
  onOpenChange,
  repoDisplayName,
  setup,
  archive,
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
            {t(
              'auto.components.sidebar.SetupScriptReviewDialog.description',
              'Saving runs this whenever Orca creates a worktree for {{repo}}.',
              { repo: repoDisplayName }
            )}
          </DialogDescription>
        </DialogHeader>

        <ScriptBlock
          heading={t('auto.components.sidebar.SetupScriptReviewDialog.setupScript', 'Setup script')}
          script={setup}
        />
        {archive ? (
          <ScriptBlock
            heading={t(
              'auto.components.sidebar.SetupScriptReviewDialog.archiveScript',
              'Archive script'
            )}
            script={archive}
          />
        ) : null}

        {provenance ? (
          <p className="text-xs text-muted-foreground">
            <Trans
              i18n={i18n}
              defaults={t(
                'auto.components.sidebar.SetupScriptPromptCardViews.detectedFromSource',
                'Detected from <source>{{source}}</source>'
              )}
              values={{ source: provenance }}
              components={{ source: <code className="rounded bg-muted px-1 py-0.5" /> }}
            />
          </p>
        ) : null}

        <DialogFooter>
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
