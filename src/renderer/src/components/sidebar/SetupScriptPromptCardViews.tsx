import React from 'react'
import { Check, LoaderCircle, PackageCheck, RefreshCw, ScrollText, Settings, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/class-names'
import { Trans } from 'react-i18next'
import { i18n } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { getDetectedSetupScriptTextareaRows } from '@/lib/script-textarea-rows'

type DismissButtonProps = {
  onDismiss: () => void
}

function DismissButton({ onDismiss }: DismissButtonProps): React.JSX.Element {
  const t = useTranslate()
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={t(
            'auto.components.sidebar.SetupScriptPromptCardViews.5bfd5c8779',
            'Dismiss setup scripts'
          )}
          className="-mr-1 text-muted-foreground"
          onClick={onDismiss}
        >
          <X className="size-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {t('auto.components.sidebar.SetupScriptPromptCardViews.822ff300ad', 'Dismiss')}
      </TooltipContent>
    </Tooltip>
  )
}

export type DetectedSetupPreviewProps = {
  setup: string
  onSetupChange: (value: string) => void
  provenance: string | null
}

// Package-manager guesses only: imports are summarized in one line and reviewed in a dialog.
export function DetectedSetupPreview({
  setup,
  onSetupChange,
  provenance
}: DetectedSetupPreviewProps): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="mt-3 border-t border-worktree-sidebar-border pt-3">
      <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        <PackageCheck className="size-3.5" />
        {t('auto.components.sidebar.SetupScriptPromptCardViews.7275f674cc', 'Detected setup')}
      </div>
      <textarea
        value={setup}
        aria-label={t(
          'auto.components.sidebar.SetupScriptPromptCardViews.fdbc6cb064',
          'Detected setup script'
        )}
        onChange={(event) => onSetupChange(event.target.value)}
        spellCheck={false}
        rows={getDetectedSetupScriptTextareaRows(setup)}
        className="setup-script-prompt-command max-h-28 w-full resize-y overflow-auto scrollbar-sleek rounded-md border border-worktree-sidebar-border px-2 py-1.5 font-mono text-[11px] leading-5 text-foreground shadow-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />
      {provenance ? (
        <p className="mt-1.5 text-[11px] text-muted-foreground">
          <Trans
            i18n={i18n}
            defaults={t(
              'auto.components.sidebar.SetupScriptPromptCardViews.detectedFromSource',
              'Detected from <file>{{source}}</file>'
            )}
            values={{ source: provenance }}
            components={{ file: <code className="rounded bg-muted px-1 py-0.5" /> }}
          />
        </p>
      ) : null}
    </div>
  )
}

export type ReviewSetupActionProps = {
  onReview: () => void
}

export function ReviewSetupAction({ onReview }: ReviewSetupActionProps): React.JSX.Element {
  const t = useTranslate()
  return (
    <Button
      type="button"
      variant="default"
      size="sm"
      className="mt-3 h-7 w-full text-xs"
      onClick={onReview}
    >
      <ScrollText className="size-3.5" />
      <span className="truncate">
        {t(
          'auto.components.sidebar.SetupScriptPromptCardViews.reviewSetupScript',
          'Review setup script'
        )}
      </span>
    </Button>
  )
}

export type PackageManagerActionsProps = {
  isSaving: boolean
  onSave: () => void
  onConfigure: () => void
}

export function PackageManagerActions({
  isSaving,
  onSave,
  onConfigure
}: PackageManagerActionsProps): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="mt-3 flex flex-col gap-2">
      <Button
        type="button"
        variant="default"
        size="sm"
        className="h-7 w-full text-xs"
        onClick={onSave}
        disabled={isSaving}
      >
        {isSaving ? (
          <LoaderCircle className="size-3.5 animate-spin" />
        ) : (
          <Check className="size-3.5" />
        )}
        <span className={cn('truncate', isSaving && 'text-muted-foreground')}>
          {t('auto.components.sidebar.SetupScriptPromptCardViews.ca4efcbc25', 'Save')}
        </span>
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 w-full text-xs text-muted-foreground"
        onClick={onConfigure}
      >
        <Settings className="size-3.5" />
        <span className="truncate">
          {t('auto.components.sidebar.SetupScriptPromptCardViews.eefa756190', 'Configure manually')}
        </span>
      </Button>
    </div>
  )
}

export type SetupScriptPromptBodyProps = {
  isInspectionError: boolean
  sharedSetupIgnored: boolean
  isPackageManagerSuggestion: boolean
  candidateSource: string | null
}

export function SetupScriptPromptBody({
  isInspectionError,
  sharedSetupIgnored,
  isPackageManagerSuggestion,
  candidateSource
}: SetupScriptPromptBodyProps): React.JSX.Element {
  const t = useTranslate()
  if (isInspectionError) {
    return (
      <>
        {t(
          'auto.components.sidebar.SetupScriptPromptCardViews.0155fb9ed3',
          "Couldn't verify this repo's setup script right now."
        )}
      </>
    )
  }
  if (sharedSetupIgnored) {
    return (
      <Trans
        i18n={i18n}
        defaults={t(
          'auto.components.sidebar.SetupScriptPromptCardViews.ignoresSharedSetup',
          'This repo ignores shared <yaml>orca.yaml</yaml> setup scripts. Add a local command, or change the source in Settings.'
        )}
        components={{ yaml: <code /> }}
      />
    )
  }
  const sourceElement = <span className="break-words text-foreground" />
  if (isPackageManagerSuggestion) {
    return (
      <>
        {t(
          'auto.components.sidebar.SetupScriptPromptCardViews.aef6c0a213',
          'Save the detected command to run it whenever Orca creates a worktree.'
        )}
      </>
    )
  }
  if (candidateSource) {
    return (
      <Trans
        i18n={i18n}
        defaults={t(
          'auto.components.sidebar.SetupScriptPromptCardViews.foundSetupScriptIn',
          'Found a setup script in <file>{{source}}</file>.'
        )}
        values={{ source: candidateSource }}
        components={{ file: sourceElement }}
      />
    )
  }
  return (
    <>
      {t(
        'auto.components.sidebar.SetupScriptPromptCardViews.0a98169776',
        'Add a setup command to run when Orca creates new worktrees.'
      )}
    </>
  )
}

export type InspectionErrorActionsProps = {
  onRetry: () => void
  onConfigure: () => void
}

export function InspectionErrorActions({
  onRetry,
  onConfigure
}: InspectionErrorActionsProps): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="mt-3 flex gap-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-7 flex-1 text-xs"
        onClick={onRetry}
      >
        <RefreshCw className="size-3.5" />
        <span className="truncate">
          {t('auto.components.sidebar.SetupScriptPromptCardViews.4a98f907ae', 'Retry')}
        </span>
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-xs"
        onClick={onConfigure}
      >
        <Settings className="size-3.5" />
        <span className="sr-only">
          {t('auto.components.sidebar.SetupScriptPromptCardViews.31b8b01a45', 'Settings')}
        </span>
      </Button>
    </div>
  )
}

export type ConfigureOnlyActionProps = {
  onConfigure: () => void
}

export function ConfigureOnlyAction({ onConfigure }: ConfigureOnlyActionProps): React.JSX.Element {
  const t = useTranslate()
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="mt-3 h-7 w-full text-xs"
      onClick={onConfigure}
    >
      <Settings className="size-3.5" />
      <span className="truncate">
        {t('auto.components.sidebar.SetupScriptPromptCardViews.3933401d28', 'Configure')}
      </span>
    </Button>
  )
}

export { DismissButton }
