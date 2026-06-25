import React from 'react'
import { Check, Download, LoaderCircle, PackageCheck, RefreshCw, Settings, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { getDetectedSetupScriptTextareaRows } from '@/lib/script-textarea-rows'

type DismissButtonProps = {
  onDismiss: () => void
}

function DismissButton({ onDismiss }: DismissButtonProps): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={translate(
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
        {translate('auto.components.sidebar.SetupScriptPromptCardViews.822ff300ad', 'Dismiss')}
      </TooltipContent>
    </Tooltip>
  )
}

export type DetectedSetupPreviewProps = {
  setup: string
  onSetupChange: (value: string) => void
  provenance: string | null
}

export function DetectedSetupPreview({
  setup,
  onSetupChange,
  provenance
}: DetectedSetupPreviewProps): React.JSX.Element {
  return (
    <div className="mt-3 border-t border-worktree-sidebar-border pt-3">
      <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        <PackageCheck className="size-3.5" />
        {translate(
          'auto.components.sidebar.SetupScriptPromptCardViews.7275f674cc',
          'Detected setup'
        )}
      </div>
      <textarea
        value={setup}
        aria-label={translate(
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
          {translate(
            'auto.components.sidebar.SetupScriptPromptCardViews.d02e6a42b1',
            'Detected from'
          )}
          <code className="rounded bg-muted px-1 py-0.5">{provenance}</code>
        </p>
      ) : null}
    </div>
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
          {translate('auto.components.sidebar.SetupScriptPromptCardViews.ca4efcbc25', 'Save')}
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
          {translate(
            'auto.components.sidebar.SetupScriptPromptCardViews.eefa756190',
            'Configure manually'
          )}
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
  if (isInspectionError) {
    return (
      <>
        {translate(
          'auto.components.sidebar.SetupScriptPromptCardViews.0155fb9ed3',
          "Couldn't verify this repo's setup script right now."
        )}
      </>
    )
  }
  if (sharedSetupIgnored) {
    return (
      <>
        {translate(
          'auto.components.sidebar.SetupScriptPromptCardViews.bb879db364',
          'This repo ignores shared'
        )}
        <code>
          {translate('auto.components.sidebar.SetupScriptPromptCardViews.8f6be51aa1', 'orca.yaml')}
        </code>{' '}
        {translate(
          'auto.components.sidebar.SetupScriptPromptCardViews.660cdc17f8',
          'setup scripts. Add a local command, or change the source in Settings.'
        )}
      </>
    )
  }
  if (isPackageManagerSuggestion) {
    return (
      <>
        {translate(
          'auto.components.sidebar.SetupScriptPromptCardViews.aef6c0a213',
          'Save the detected command to run it whenever Orca creates a worktree.'
        )}
      </>
    )
  }
  if (candidateSource) {
    return (
      <>
        {translate(
          'auto.components.sidebar.SetupScriptPromptCardViews.b56d1322f7',
          'Found a setup command in'
        )}
        <span className="break-words">{candidateSource}</span>
        {translate(
          'auto.components.sidebar.SetupScriptPromptCardViews.8349e3fa4c',
          '. Save it to run for new worktrees.'
        )}
      </>
    )
  }
  return (
    <>
      {translate(
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
          {translate('auto.components.sidebar.SetupScriptPromptCardViews.4a98f907ae', 'Retry')}
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
          {translate('auto.components.sidebar.SetupScriptPromptCardViews.31b8b01a45', 'Settings')}
        </span>
      </Button>
    </div>
  )
}

export type ConfigureOnlyActionProps = {
  onConfigure: () => void
}

export function ConfigureOnlyAction({ onConfigure }: ConfigureOnlyActionProps): React.JSX.Element {
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
        {translate('auto.components.sidebar.SetupScriptPromptCardViews.3933401d28', 'Configure')}
      </span>
    </Button>
  )
}

export type SaveLocalSetupActionProps = {
  isSaving: boolean
  onSave: () => void
}

export function SaveLocalSetupAction({
  isSaving,
  onSave
}: SaveLocalSetupActionProps): React.JSX.Element {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="mt-3 h-7 w-full text-xs"
      onClick={onSave}
      disabled={isSaving}
    >
      {isSaving ? (
        <LoaderCircle className="size-3.5 animate-spin" />
      ) : (
        <Download className="size-3.5" />
      )}
      <span className={cn('truncate', isSaving && 'text-muted-foreground')}>
        {translate(
          'auto.components.sidebar.SetupScriptPromptCardViews.96a7f4198c',
          'Save local setup'
        )}
      </span>
    </Button>
  )
}

export { DismissButton }
