import React from 'react'
import { LoaderCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SwitchIndicator } from '@/components/ui/switch'
import { useTranslate } from '@/i18n/use-translate'
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
  | 'cloudStart'
> & {
  submitShortcutModifierLabel: string
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
  submitShortcutModifierLabel,
  cloudStart
}: NewWorkspaceComposerFooterProps): React.JSX.Element {
  const t = useTranslate()
  const heldReasonId = React.useId()
  // B2: Start stays focusable but aria-disabled, saying why ("Switch to acme first").
  const heldReason = cloudStart?.primaryHeldReason
  return (
    <>
      {createError ? (
        <div
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          {createError.help ? (
            <div className="space-y-1">
              <p className="font-medium">{createError.title}</p>
              <p>{createError.message}</p>
              <p className="text-destructive/85">{createError.help}</p>
            </div>
          ) : (
            createError.message
          )}
        </div>
      ) : null}

      {/* Wraps instead of overflowing: "Use this computer instead" plus a long primary label
          ("Give access and start") don't fit beside "Create more" in the modal's width. */}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        {showCreateMultiple ? (
          <button
            type="button"
            role="switch"
            aria-checked={createMultiple}
            onClick={() => onCreateMultipleChange?.(!createMultiple)}
            className="group flex w-fit cursor-pointer items-center gap-2 rounded-md text-xs outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-solid focus-visible:outline-focus-ring"
          >
            <SwitchIndicator checked={createMultiple} />
            <span className="whitespace-nowrap text-muted-foreground transition-colors group-hover:text-foreground">
              {t('auto.components.NewWorkspaceComposerCard.createMultiple', 'Create more')}
            </span>
          </button>
        ) : null}
        <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-x-3 gap-y-2">
          {cloudStart?.onUseThisComputer ? (
            <Button type="button" variant="ghost" size="sm" onClick={cloudStart.onUseThisComputer}>
              {t('components.newWorkspace.cloudStart.useThisComputer', 'Use this computer instead')}
            </Button>
          ) : null}
          <Button
            onClick={heldReason ? undefined : () => void onCreate()}
            disabled={createDisabled}
            aria-disabled={heldReason ? true : undefined}
            aria-describedby={heldReason ? heldReasonId : undefined}
            title={heldReason}
            variant={heldReason ? 'default-held' : 'default'}
            size="sm"
            className="text-xs"
          >
            {creating ? <LoaderCircle className="size-4 animate-spin" /> : null}
            {primaryActionLabel}
            <ButtonKeyHint modifierLabel={submitShortcutModifierLabel} />
          </Button>
        </div>
        {heldReason ? (
          <span id={heldReasonId} className="sr-only">
            {heldReason}
          </span>
        ) : null}
      </div>
    </>
  )
}
