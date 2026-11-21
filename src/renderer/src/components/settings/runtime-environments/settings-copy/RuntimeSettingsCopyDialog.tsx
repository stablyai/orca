import { useTranslate } from '@/i18n/use-translate'
import { Button } from '../../../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../../../ui/dialog'
import { LoadingSpinner } from '../../../ui/LoadingSpinner'
import { ToggleGroup, ToggleGroupItem } from '../../../ui/toggle-group'
import { SettingsCopyPreviewBody } from './settings-copy-preview'
import type { SettingsCopyController } from './use-settings-copy'

/** Copies portable settings between this computer and one paired Orca, after a preview. */
export function RuntimeSettingsCopyDialog({
  name,
  copy
}: {
  /** The paired Orca's name. */
  name: string
  copy: SettingsCopyController
}): React.JSX.Element {
  const t = useTranslate()
  const { state, direction } = copy
  // Mid-sentence, so lower case: "Will change on this computer".
  const here = t('auto.components.settings.settingsCopy.thisComputer', 'this computer')
  const [source, target] = direction === 'send' ? [here, name] : [name, here]
  const canApply = state.phase === 'ready' && state.preview.changed.length > 0
  const applying = state.phase === 'applying'
  const finished = state.phase === 'applied'
  return (
    <Dialog open={copy.open} onOpenChange={(open) => (open ? undefined : copy.close())}>
      {/* A copy in progress still writes after the dialog closes, so it cannot be dismissed.
          Scrollable keeps the buttons reachable when a long list meets a short window. */}
      <DialogContent className="sm:max-w-md" busy={applying} scrollable>
        <DialogHeader>
          <DialogTitle>
            {t('auto.components.settings.settingsCopy.title', 'Copy settings with {{name}}', {
              name
            })}
          </DialogTitle>
          <DialogDescription>
            {t(
              'auto.components.settings.settingsCopy.description',
              'Copies preferences such as appearance, terminal, editor and diff settings. Accounts, keys and projects are not copied.'
            )}
          </DialogDescription>
        </DialogHeader>
        <ToggleGroup
          type="single"
          variant="segmented"
          size="sm"
          spacing={1}
          className="w-full"
          aria-label={t('auto.components.settings.settingsCopy.directionLabel', 'Copy direction')}
          value={direction}
          disabled={applying || finished}
          onValueChange={(value) => {
            if (value === 'send' || value === 'receive') {
              copy.chooseDirection(value)
            }
          }}
        >
          <ToggleGroupItem value="send" className="flex-1">
            {t('auto.components.settings.settingsCopy.send', 'Send from this computer')}
          </ToggleGroupItem>
          <ToggleGroupItem value="receive" className="flex-1">
            {t('auto.components.settings.settingsCopy.receive', 'Bring to this computer')}
          </ToggleGroupItem>
        </ToggleGroup>
        <SettingsCopyPreviewBody state={state} name={name} source={source} target={target} />
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={applying}
            onClick={copy.close}
          >
            {finished
              ? t('auto.components.settings.serverList.done', 'Done')
              : t('auto.components.settings.serverList.cancel', 'Cancel')}
          </Button>
          {state.phase === 'failed' ? (
            <Button type="button" size="sm" onClick={copy.retry}>
              {t('auto.components.settings.settingsCopy.retry', 'Try again')}
            </Button>
          ) : null}
          {finished || state.phase === 'failed' ? null : (
            <Button type="button" size="sm" disabled={!canApply} onClick={copy.apply}>
              {applying ? <LoadingSpinner /> : null}
              {t('auto.components.settings.settingsCopy.apply', 'Copy to {{target}}', { target })}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
