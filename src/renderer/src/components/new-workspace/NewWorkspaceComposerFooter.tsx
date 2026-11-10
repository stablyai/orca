import React from 'react'
import { LoaderCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SwitchIndicator } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
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

      <div
        className={cn(
          'flex items-center gap-3',
          showCreateMultiple ? 'justify-between' : 'justify-end'
        )}
      >
        {showCreateMultiple ? (
          <button
            type="button"
            role="switch"
            aria-checked={createMultiple}
            onClick={() => onCreateMultipleChange?.(!createMultiple)}
            className="group flex w-fit cursor-pointer items-center gap-2 rounded-md text-xs outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-solid focus-visible:outline-focus-ring"
          >
            <SwitchIndicator checked={createMultiple} />
            <span className="text-muted-foreground transition-colors group-hover:text-foreground">
              {t('auto.components.NewWorkspaceComposerCard.createMultiple', 'Create more')}
            </span>
          </button>
        ) : null}
        {cloudStart?.onUseThisComputer ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="ml-auto"
            onClick={cloudStart.onUseThisComputer}
          >
            {t('components.newWorkspace.cloudStart.useThisComputer', 'Use this computer instead')}
          </Button>
        ) : null}
        <Button
          onClick={() => void onCreate()}
          disabled={createDisabled}
          size="sm"
          className="text-xs"
        >
          {creating ? <LoaderCircle className="size-4 animate-spin" /> : null}
          {primaryActionLabel}
          <ButtonKeyHint modifierLabel={submitShortcutModifierLabel} />
        </Button>
      </div>
    </>
  )
}
