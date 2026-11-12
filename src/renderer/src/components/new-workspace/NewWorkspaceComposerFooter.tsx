import { ORCA_CLOUD_NEEDS_REPO_ID } from './run-on/cloud-start-view'
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
  cloudStart = null
}: NewWorkspaceComposerFooterProps): React.JSX.Element {
  const t = useTranslate()
  // RR-c1: why Create waits (a folder project on Orca Cloud), on hover and for screen readers.
  // RR-c1: set only after a Create stopped for it; the button stays enabled and points at the error.
  const needsRepo = Boolean(cloudStart?.needsGitHubRepo)
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

      {/* One row: "Create more" on the left, the one primary button on the right. Run on never
          adds buttons here; Orca Cloud setup happens on its own page after the button. */}
      <div className="flex items-center justify-between gap-3">
        {showCreateMultiple ? (
          <button
            type="button"
            role="switch"
            aria-checked={createMultiple}
            onClick={() => onCreateMultipleChange?.(!createMultiple)}
            className="group flex w-fit shrink-0 cursor-pointer items-center gap-2 rounded-md text-xs outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-solid focus-visible:outline-focus-ring"
          >
            <SwitchIndicator checked={createMultiple} />
            <span className="whitespace-nowrap text-muted-foreground transition-colors group-hover:text-foreground">
              {t('auto.components.NewWorkspaceComposerCard.createMultiple', 'Create more')}
            </span>
          </button>
        ) : null}
        <span className="ml-auto shrink-0">
          <Button
            onClick={() => void onCreate()}
            disabled={createDisabled}
            size="sm"
            {...(needsRepo ? { 'aria-describedby': ORCA_CLOUD_NEEDS_REPO_ID } : {})}
          >
            {/* The footer's compact type, as before; the Button keeps its own variant styling. */}
            <span className="flex items-center gap-1.5 whitespace-nowrap text-xs">
              {creating ? <LoaderCircle className="size-4 animate-spin" /> : null}
              {primaryActionLabel}
              <ButtonKeyHint modifierLabel={submitShortcutModifierLabel} />
            </span>
          </Button>
        </span>
      </div>
    </>
  )
}
