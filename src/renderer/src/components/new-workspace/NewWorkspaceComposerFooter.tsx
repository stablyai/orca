import React from 'react'
import { LoaderCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SwitchIndicator } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { ButtonKeyHint } from '@/components/ButtonKeyHint'
import type { NewWorkspaceComposerCardProps } from './new-workspace-composer-card-props'

type NewWorkspaceComposerFooterProps = Pick<
  NewWorkspaceComposerCardProps,
  | 'createError'
  | 'showCreateMultiple'
  | 'createMultiple'
  | 'onCreateMultipleChange'
  | 'onCreate'
  | 'createDisabled'
  | 'creating'
  | 'primaryActionLabel'
  | 'multiRepo'
> & {
  submitShortcutModifierLabel: string
  onChooseHost?: () => void
}

export function NewWorkspaceComposerFooter({
  createError,
  showCreateMultiple = false,
  createMultiple = false,
  onCreateMultipleChange,
  onCreate,
  createDisabled,
  creating,
  primaryActionLabel,
  multiRepo,
  onChooseHost,
  submitShortcutModifierLabel
}: NewWorkspaceComposerFooterProps): React.JSX.Element {
  const multiActive = multiRepo?.active === true
  const shownError = multiActive ? multiRepo.createError : createError
  const shownCreating = multiActive ? multiRepo.creating : creating
  const blockedReason = multiActive ? multiRepo.blockedReason : null
  return (
    <>
      {multiActive && multiRepo.mixedHostsError ? (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          <p>
            {translate(
              'auto.components.newWorkspace.multiRepo.mixedHosts',
              'Selected projects span more than one host. Pick a host to continue.'
            )}
          </p>
          <Button type="button" variant="outline" size="xs" onClick={onChooseHost}>
            {translate('auto.components.newWorkspace.multiRepo.chooseHost', 'Choose host')}
          </Button>
        </div>
      ) : null}
      {shownError ? (
        <div
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          {shownError.help ? (
            <div className="space-y-1">
              <p className="font-medium">{shownError.title}</p>
              <p>{shownError.message}</p>
              <p className="text-destructive/85">{shownError.help}</p>
            </div>
          ) : (
            shownError.message
          )}
        </div>
      ) : null}

      <div
        className={cn(
          'flex items-center gap-3',
          showCreateMultiple && !multiActive ? 'justify-between' : 'justify-end'
        )}
      >
        {showCreateMultiple && !multiActive ? (
          <button
            type="button"
            role="switch"
            aria-checked={createMultiple}
            onClick={() => onCreateMultipleChange?.(!createMultiple)}
            className="group flex w-fit cursor-pointer items-center gap-2 rounded-md text-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            <SwitchIndicator checked={createMultiple} />
            <span className="text-muted-foreground transition-colors group-hover:text-foreground">
              {translate('auto.components.NewWorkspaceComposerCard.createMultiple', 'Create more')}
            </span>
          </button>
        ) : null}
        {blockedReason ? (
          <span role="status" className="min-w-0 text-[11px] text-muted-foreground">
            {blockedReason}
          </span>
        ) : null}
        <Button
          onClick={() => void onCreate()}
          disabled={createDisabled}
          size="sm"
          className="text-xs"
        >
          {shownCreating ? <LoaderCircle className="size-4 animate-spin" /> : null}
          {primaryActionLabel}
          <ButtonKeyHint modifierLabel={submitShortcutModifierLabel} />
        </Button>
      </div>
    </>
  )
}
