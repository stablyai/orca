import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { InstalledBrowser } from '../../../../shared/external-browser-types'
import { Label } from '../ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue
} from '../ui/select'
import { SearchableSetting } from './SearchableSetting'
import { translate } from '@/i18n/i18n'

type BrowserLinkRoutingSettingProps = {
  settings: GlobalSettings
  /** Null while the installed-browser list loads. */
  installedBrowsers: InstalledBrowser[] | null
  linkRoutingDescription: string
  isMac: boolean
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

const ORCA_VALUE = 'orca'
const SYSTEM_VALUE = 'system'
// Prefix browser ids so an installed browser can never collide with the fixed options.
const BROWSER_VALUE_PREFIX = 'browser:'

function linkDestinationValue(settings: GlobalSettings): string {
  if (settings.openLinksInApp) {
    return ORCA_VALUE
  }
  return settings.externalBrowserId
    ? `${BROWSER_VALUE_PREFIX}${settings.externalBrowserId}`
    : SYSTEM_VALUE
}

function linkDestinationUpdates(value: string): Partial<GlobalSettings> {
  const browserId = value.startsWith(BROWSER_VALUE_PREFIX)
    ? value.slice(BROWSER_VALUE_PREFIX.length)
    : null
  return {
    openLinksInApp: value === ORCA_VALUE,
    externalBrowserId: browserId,
    openLinksInAppPreferencePrompted: true
  }
}

export function BrowserLinkRoutingSetting({
  settings,
  installedBrowsers,
  linkRoutingDescription,
  isMac,
  updateSettings
}: BrowserLinkRoutingSettingProps): React.JSX.Element {
  const title = translate('auto.components.settings.BrowserPane.d3eb69c0aa', 'Link Routing')
  const loading = installedBrowsers === null
  const value = linkDestinationValue(settings)
  const missingBrowserId =
    !loading &&
    !settings.openLinksInApp &&
    settings.externalBrowserId &&
    !installedBrowsers.some((browser) => browser.id === settings.externalBrowserId)
      ? settings.externalBrowserId
      : null

  return (
    <SearchableSetting
      title={title}
      description={linkRoutingDescription}
      keywords={[
        'browser',
        'preview',
        'links',
        'localhost',
        'webview',
        'markdown',
        isMac ? 'cmd' : 'ctrl',
        'file',
        'editor',
        'default browser',
        'chrome',
        'edge',
        'firefox',
        'safari'
      ]}
      className="flex items-center justify-between gap-4 py-2"
    >
      <div className="space-y-0.5">
        <Label>{title}</Label>
        <p className="text-xs text-muted-foreground">{linkRoutingDescription}</p>
      </div>
      <Select
        value={loading ? '' : value}
        disabled={loading}
        onValueChange={(next) => updateSettings(linkDestinationUpdates(next))}
      >
        <SelectTrigger aria-label={title} className="h-7 w-56 shrink-0">
          <SelectValue
            placeholder={translate(
              'auto.components.settings.BrowserLinkRoutingSetting.loadingBrowsers',
              'Loading browsers…'
            )}
          />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ORCA_VALUE}>
            {translate(
              'auto.components.terminal.pane.TerminalLinkActionPopover.orcaBrowser',
              'Orca Browser'
            )}
          </SelectItem>
          <SelectItem value={SYSTEM_VALUE}>
            {translate(
              'auto.components.settings.BrowserLinkRoutingSetting.systemDefaultBrowser',
              'System default browser'
            )}
          </SelectItem>
          {installedBrowsers?.length || missingBrowserId ? <SelectSeparator /> : null}
          {installedBrowsers?.map((browser) => (
            <SelectItem key={browser.id} value={`${BROWSER_VALUE_PREFIX}${browser.id}`}>
              {browser.name}
            </SelectItem>
          ))}
          {missingBrowserId ? (
            <SelectItem value={`${BROWSER_VALUE_PREFIX}${missingBrowserId}`}>
              {translate(
                'auto.components.settings.BrowserLinkRoutingSetting.unavailableBrowser',
                'Unavailable browser (using system default)'
              )}
            </SelectItem>
          ) : null}
        </SelectContent>
      </Select>
    </SearchableSetting>
  )
}
