import { useCallback } from 'react'
import type { PluginHostListEntry } from '../../../../preload/api-types'
import { translate } from '@/i18n/i18n'
import { PluginSandboxFrame } from '../right-sidebar/PluginSandboxFrame'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'

export type OpenPluginSettingsPage = {
  plugin: Pick<PluginHostListEntry, 'pluginKey' | 'name'>
  page: { id: string; title: string }
}

type PluginSettingsPageDialogProps = {
  open: OpenPluginSettingsPage | null
  onClose: () => void
}

/** A plugin's own settings page, mounted in the same sandboxed shell as its
 *  panels; the frame lives only while the dialog is open. */
export function PluginSettingsPageDialog({
  open,
  onClose
}: PluginSettingsPageDialogProps): React.JSX.Element {
  // Health only feeds the sidebar badge for panels; the frame shows its own errors here.
  const ignoreHealth = useCallback(() => undefined, [])
  return (
    <Dialog open={Boolean(open)} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="flex h-[70vh] max-h-[640px] flex-col sm:max-w-2xl">
        <DialogHeader>
          {/* Page titles come from the plugin manifest and render untranslated by design. */}
          <DialogTitle>{open?.page.title ?? ''}</DialogTitle>
          <DialogDescription>
            {translate(
              'auto.components.settings.PluginSettingsPageDialog.description',
              'Provided by the {{value0}} plugin and shown in a sandbox.',
              { value0: open?.plugin.name ?? '' }
            )}
          </DialogDescription>
        </DialogHeader>
        {open ? (
          <div className="flex min-h-0 flex-1 overflow-hidden rounded-md border border-border">
            <PluginSandboxFrame
              pluginKey={open.plugin.pluginKey}
              contributionId={open.page.id}
              surface="settingsPage"
              title={open.page.title}
              frameId={`settings:${open.plugin.pluginKey}/${open.page.id}`}
              onHealthChange={ignoreHealth}
            />
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
