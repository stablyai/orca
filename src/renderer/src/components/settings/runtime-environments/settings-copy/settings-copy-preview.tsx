import { CircleCheck } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { LoadingSpinner } from '../../../ui/LoadingSpinner'
import type { SettingsCopyState } from './use-settings-copy'

function SettingKeyList({ keys }: { keys: string[] }): React.JSX.Element {
  return (
    <ul className="scrollbar-sleek max-h-48 overflow-y-auto rounded-md border border-border/60 bg-muted/30 px-3 py-2 font-mono text-xs">
      {keys.map((key) => (
        <li key={key} className="py-0.5">
          {key}
        </li>
      ))}
    </ul>
  )
}

/** What the copy would change, what it changed, or why it could not run. */
export function SettingsCopyPreviewBody({
  state,
  name,
  source,
  target
}: {
  state: SettingsCopyState
  /** The paired Orca's name, for the update hint. */
  name: string
  source: string
  target: string
}): React.JSX.Element {
  const t = useTranslate()
  if (state.phase === 'checking') {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
        <LoadingSpinner className="size-4" />
        {t('auto.components.settings.settingsCopy.checking', 'Checking what would change…')}
      </div>
    )
  }
  if (state.phase === 'failed') {
    return (
      <p className="text-sm text-destructive" role="alert">
        {state.pairingChanged
          ? t(
              'auto.components.settings.settingsCopy.pairingChanged',
              '{{name}} was paired again after the check, so nothing was copied. Try again to see what would change.',
              { name }
            )
          : state.unsupported
            ? t(
                'auto.components.settings.settingsCopy.unsupported',
                'Orca on {{name}} can’t copy settings yet. Update Orca there and try again.',
                { name }
              )
            : t(
                'auto.components.settings.settingsCopy.failed',
                'Couldn’t copy settings: {{message}}',
                {
                  message: state.message
                }
              )}
      </p>
    )
  }
  const { preview } = state
  const applied = state.phase === 'applied'
  const changed = applied ? state.result.changed : preview.changed
  const skipped = applied ? state.result.skipped : preview.skipped
  const anySkipped = preview.notSent.length > 0 || skipped.length > 0
  return (
    <div className="flex flex-col gap-2 text-sm" aria-live="polite">
      {changed.length === 0 ? (
        <p>
          {anySkipped
            ? t(
                'auto.components.settings.settingsCopy.nothingToChange',
                'Nothing to change on {{target}}.',
                { target }
              )
            : t(
                'auto.components.settings.settingsCopy.alreadyMatch',
                'Settings on {{target}} already match.',
                { target }
              )}
        </p>
      ) : (
        <>
          <p className="flex items-center gap-1.5">
            {applied ? (
              <CircleCheck className="size-4 text-status-success" aria-hidden="true" />
            ) : null}
            {applied
              ? t(
                  'auto.components.settings.settingsCopy.changedHeading',
                  'Changed on {{target}} ({{total}}):',
                  {
                    target,
                    total: changed.length
                  }
                )
              : t(
                  'auto.components.settings.settingsCopy.willChangeHeading',
                  'Will change on {{target}} ({{total}}):',
                  {
                    target,
                    total: changed.length
                  }
                )}
          </p>
          <SettingKeyList keys={changed} />
        </>
      )}
      {preview.notSent.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          {t(
            'auto.components.settings.settingsCopy.notSent',
            'Not sent from {{source}}: {{keys}}',
            {
              source,
              keys: preview.notSent.join(', ')
            }
          )}
        </p>
      ) : null}
      {skipped.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          {t(
            'auto.components.settings.settingsCopy.notCopied',
            'Not copied by {{target}}: {{keys}}',
            {
              target,
              keys: skipped.join(', ')
            }
          )}
        </p>
      ) : null}
    </div>
  )
}
