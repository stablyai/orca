// @protected-copy: saved site permission choices.
import { useEffect, useState } from 'react'
import type { BrowserSessionProfile } from '../../../../../shared/browser-workspace-types'
import {
  BROWSER_SITE_PERMISSIONS,
  isBrowserSitePermissionDecision,
  type BrowserSitePermission,
  type BrowserSitePermissionEntry
} from '../../../../../shared/browser-site-permission'
import { Label } from '../../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'
import {
  browserSitePermissionLabel,
  browserSitePermissionSiteName
} from '../../browser-pane/browser-site-permission-copy'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { SettingsRow } from '../form-controls/SettingsFormControls'
import { getBrowserSitePermissionsSearchEntry } from './browser-site-permissions-search'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../shared/execution-host'
import { useAppStore } from '../../../store/index'
import { useTranslate } from '@/i18n/use-translate'

function SitePermissionRow({
  entry,
  permission,
  onChange
}: {
  entry: BrowserSitePermissionEntry
  permission: BrowserSitePermission
  onChange: (permission: BrowserSitePermission, value: string) => void
}): React.JSX.Element {
  const t = useTranslate()
  const label = browserSitePermissionLabel(permission, t)
  return (
    <SettingsRow
      label={label}
      control={
        <Select
          value={entry.decisions[permission]}
          onValueChange={(value) => onChange(permission, value)}
        >
          <SelectTrigger size="sm" className="w-28" aria-label={label}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="end">
            <SelectItem value="allow">
              {t('settings.browser.sitePermissions.allow', 'Allow')}
            </SelectItem>
            <SelectItem value="block">
              {t('settings.browser.sitePermissions.block', 'Block')}
            </SelectItem>
            <SelectItem value="ask">
              {t('settings.browser.sitePermissions.ask', 'Ask again')}
            </SelectItem>
          </SelectContent>
        </Select>
      }
    />
  )
}

const NO_PROFILES: readonly BrowserSessionProfile[] = []

/** Remembered answers live on this computer, so only its own browser profiles are listed. */
export function BrowserSitePermissionsSetting(): React.JSX.Element {
  const t = useTranslate()
  const profiles =
    useAppStore((s) => s.browserSessionProfilesByHostId[LOCAL_EXECUTION_HOST_ID]) ?? NO_PROFILES
  const fetchBrowserSessionProfiles = useAppStore((s) => s.fetchBrowserSessionProfiles)
  const [selectedProfileId, setSelectedProfileId] = useState('default')
  const profileId = profiles.some((profile) => profile.id === selectedProfileId)
    ? selectedProfileId
    : 'default'
  // Tag rows by profile so previous-profile permissions cannot be shown or edited.
  const [loaded, setLoaded] = useState<{
    profileId: string
    entries: BrowserSitePermissionEntry[]
  } | null>(null)
  const entries = loaded?.profileId === profileId ? loaded.entries : null
  const searchEntry = getBrowserSitePermissionsSearchEntry()

  // Startup may load server profiles; this computer’s permissions need local profiles explicitly.
  useEffect(() => {
    void fetchBrowserSessionProfiles(LOCAL_EXECUTION_HOST_ID)
  }, [fetchBrowserSessionProfiles])

  useEffect(() => {
    let disposed = false
    void window.api.browser
      .sitePermissionsList({ profileId })
      .then((nextEntries) => {
        if (!disposed) {
          setLoaded({ profileId, entries: nextEntries })
        }
      })
      .catch(() => {})
    return () => {
      disposed = true
    }
  }, [profileId])

  const changeDecision = (origin: string, permission: BrowserSitePermission, value: string) => {
    const writtenProfileId = profileId
    void window.api.browser
      .sitePermissionsSet({
        profileId: writtenProfileId,
        origin,
        permission,
        decision: isBrowserSitePermissionDecision(value) ? value : null
      })
      .then((nextEntries) =>
        // Late writes must not replace the newly selected profile’s rows.
        setLoaded((current) =>
          current?.profileId === writtenProfileId
            ? { profileId: writtenProfileId, entries: nextEntries }
            : current
        )
      )
      .catch(() => {})
  }

  return (
    <SearchableSetting id="browser-site-permissions" {...searchEntry} className="space-y-3 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="space-y-0.5">
          <Label>{searchEntry.title}</Label>
          <p className="text-xs text-muted-foreground">{searchEntry.description}</p>
        </div>
        {profiles.length > 1 ? (
          <Select value={profileId} onValueChange={setSelectedProfileId}>
            <SelectTrigger
              size="sm"
              className="max-w-48 shrink-0"
              aria-label={t('settings.browser.sitePermissions.profile', 'Browser profile')}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              {profiles.map((profile) => (
                <SelectItem key={profile.id} value={profile.id}>
                  {profile.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
      </div>

      {entries?.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {t(
            'settings.browser.sitePermissions.empty',
            'No sites have been allowed or blocked yet.'
          )}
        </p>
      ) : null}
      {entries && entries.length > 0 ? (
        <div className="space-y-2">
          {entries.map((entry) => (
            <div key={entry.origin} className="rounded-md border border-border/70 px-3 py-1">
              <p className="truncate pt-2 text-sm font-medium" title={entry.origin}>
                {browserSitePermissionSiteName(entry.origin, t)}
              </p>
              {BROWSER_SITE_PERMISSIONS.filter((permission) => entry.decisions[permission]).map(
                (permission) => (
                  <SitePermissionRow
                    key={permission}
                    entry={entry}
                    permission={permission}
                    onChange={(changed, value) => changeDecision(entry.origin, changed, value)}
                  />
                )
              )}
            </div>
          ))}
        </div>
      ) : null}
    </SearchableSetting>
  )
}
