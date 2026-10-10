import { useEffect, useState } from 'react'
import { Puzzle } from 'lucide-react'
import type { BrowserInstalledExtension } from '../../../../shared/browser-guest-events'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSwitch } from './SettingsFormControls'
import { getBrowserExtensionsSearchEntry } from './browser-extensions-search'

function useInstalledExtensions(): BrowserInstalledExtension[] {
  const [extensions, setExtensions] = useState<BrowserInstalledExtension[]>([])
  useEffect(() => {
    let current = true
    const refresh = (): void =>
      void window.api.browser.installedExtensions().then((next) => {
        if (current) {
          setExtensions(next)
        }
      })
    refresh()
    const unsubscribe = window.api.browser.onInstalledExtensionsChanged(refresh)
    return () => {
      current = false
      unsubscribe()
    }
  }, [])
  return extensions
}

function ExtensionRow({ extension }: { extension: BrowserInstalledExtension }): React.JSX.Element {
  const [confirmingRemove, setConfirmingRemove] = useState(false)
  const extensionId = extension.id
  return (
    <div className="flex items-center gap-3 py-2" data-extension-id={extensionId}>
      {extension.iconDataUrl ? (
        <img src={extension.iconDataUrl} alt="" className="size-6 shrink-0" />
      ) : (
        <Puzzle className="size-6 shrink-0 text-muted-foreground" />
      )}
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="truncate text-sm">
          {extension.name}{' '}
          <span className="text-xs text-muted-foreground">{extension.version}</span>
        </p>
        {extension.description ? (
          <p className="truncate text-xs text-muted-foreground">{extension.description}</p>
        ) : null}
      </div>
      {extension.hasOptions && extension.enabled ? (
        <Button
          variant="ghost"
          size="xs"
          onClick={() => void window.api.browser.openExtensionOptions({ extensionId })}
        >
          {translate('settings.browser.extensions.options', 'Options')}
        </Button>
      ) : null}
      {confirmingRemove ? (
        <Button
          variant="destructive"
          size="xs"
          onClick={() => void window.api.browser.removeExtension({ extensionId })}
          onBlur={() => setConfirmingRemove(false)}
          autoFocus
        >
          {translate('settings.browser.extensions.confirmRemove', 'Confirm remove')}
        </Button>
      ) : (
        <Button variant="ghost" size="xs" onClick={() => setConfirmingRemove(true)}>
          {translate('settings.browser.extensions.remove', 'Remove')}
        </Button>
      )}
      <SettingsSwitch
        checked={extension.enabled}
        ariaLabel={extension.name}
        onChange={() =>
          void window.api.browser.setExtensionEnabled({
            extensionId,
            enabled: !extension.enabled
          })
        }
      />
    </div>
  )
}

/** Installed Chrome extensions: turn each on or off, open its options, or remove it. */
export function BrowserExtensionsSetting(): React.JSX.Element {
  const extensions = useInstalledExtensions()
  const entry = getBrowserExtensionsSearchEntry()
  return (
    <SearchableSetting
      id="browser-extensions"
      title={entry.title}
      description={entry.description}
      keywords={entry.keywords}
      className="space-y-2 py-2"
    >
      <div className="space-y-0.5">
        <p className="text-sm font-medium">{entry.title}</p>
        <p className="text-xs text-muted-foreground">
          {translate(
            'settings.browser.extensions.help',
            'Open chromewebstore.google.com in an Orca browser tab and choose "Add to Chrome" to install one. Extensions run in browser tabs on this computer.'
          )}
        </p>
      </div>
      {extensions.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {translate('settings.browser.extensions.empty', 'No extensions installed.')}
        </p>
      ) : (
        <div className="divide-y divide-border">
          {extensions.map((extension) => (
            <ExtensionRow key={extension.id} extension={extension} />
          ))}
        </div>
      )}
    </SearchableSetting>
  )
}
