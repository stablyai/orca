import type React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Download, Loader2, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { useAppStore } from '../../../store/index'
import { Button } from '../../ui/button'
import { ReleaseBuildPicker } from './ReleaseBuildPicker'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'
import { useTranslate } from '@/i18n/use-translate'
import { AboutDisclosureRow } from './AboutDisclosureRow'
import {
  getReleaseChannelLabel,
  updaterMessageText
} from '@/app-shell/updates/updater-message-copy'
import { errorMessage } from '../../../../../shared/errors/error-message'
import type { UpdaterCodedMessage } from '../../../../../shared/updater/updater-failure-copy'
import { getShortcutPlatform } from '@/lib/keyboard/shortcut-platform'
import {
  DEV_CHANNEL_PLATFORM_LABEL,
  RELEASE_CHANNELS,
  getVersionChannel,
  isChannelSupportedOnPlatform,
  requiresManualDevChannelInstall,
  type ReleaseBuild,
  type ReleaseChannel
} from '../../../../../shared/updater/release-channel'

export function ReleaseChannelSection(): React.JSX.Element {
  const t = useTranslate()
  const updateStatus = useAppStore((s) => s.updateStatus)
  const releaseChannelOverride = useAppStore((s) => s.releaseChannelOverride)
  const setReleaseChannelOverride = useAppStore((s) => s.setReleaseChannelOverride)

  const [appVersion, setAppVersion] = useState<string | null>(null)
  const [builds, setBuilds] = useState<ReleaseBuild[] | null>(null)
  const [loadError, setLoadError] = useState<UpdaterCodedMessage | null>(null)
  const [loading, setLoading] = useState(false)
  const [selectedTag, setSelectedTag] = useState<string | null>(null)
  const [open, setOpen] = useState(false)

  const platform = getShortcutPlatform()
  const runningChannel = appVersion ? getVersionChannel(appVersion) : null
  const requestedChannel = releaseChannelOverride ?? runningChannel ?? 'stable'
  // Synced Mac profiles can carry unsupported hourly channels; fall back instead of offering uninstallable builds.
  const activeChannel = isChannelSupportedOnPlatform(requestedChannel, platform)
    ? requestedChannel
    : 'stable'
  const busy = updateStatus.state === 'checking' || updateStatus.state === 'downloading'

  // Without the running version there is no channel to compare against; a failure shows where the
  // build list would have been, and the list's Refresh retries it.
  const loadVersion = useCallback((): void => {
    void window.api.updater.getVersion().then(
      (version) => {
        setLoadError(null)
        setAppVersion(version)
      },
      (error: unknown) => setLoadError({ message: errorMessage(error) })
    )
  }, [])
  useEffect(loadVersion, [loadVersion])

  // Version resolution and rapid clicks can overlap loads; reject earlier requests that finish on the wrong channel.
  const latestRequestRef = useRef(0)

  const loadBuilds = useCallback(
    async (channel: ReleaseChannel, options?: { force?: boolean }): Promise<void> => {
      const requestId = latestRequestRef.current + 1
      latestRequestRef.current = requestId
      const isStale = (): boolean => latestRequestRef.current !== requestId
      setLoading(true)
      setLoadError(null)
      try {
        const result = await window.api.updater.listBuilds(channel, options)
        if (isStale()) {
          return
        }
        if (result.ok) {
          setBuilds(result.builds)
          setSelectedTag(result.builds[0]?.tag ?? null)
        } else {
          setBuilds(null)
          setLoadError(result)
        }
      } catch (error) {
        if (isStale()) {
          return
        }
        setBuilds(null)
        setLoadError({ message: errorMessage(error) })
      } finally {
        // Only the newest request may clear loading; old completions must not flash No builds.
        if (!isStale()) {
          setLoading(false)
        }
      }
    },
    []
  )

  // Wait for the running version/channel before loading; a stable-placeholder request would be discarded.
  useEffect(() => {
    if (appVersion === null) {
      return
    }
    setBuilds(null)
    setSelectedTag(null)
    void loadBuilds(activeChannel)
  }, [activeChannel, appVersion, loadBuilds])

  const selectedBuild = useMemo(
    () => builds?.find((build) => build.tag === selectedTag) ?? null,
    [builds, selectedTag]
  )

  const handleSwitchTo = (build: ReleaseBuild): void => {
    void window.api.updater
      .check({ channel: build.channel, targetTag: build.tag })
      .catch((error) => {
        toast.error(
          t(
            'auto.components.settings.ReleaseChannelSection.switchFailed',
            'Could not switch to that build.'
          ),
          { description: String((error as Error)?.message ?? error) }
        )
      })
  }

  const isRunningBuild = selectedBuild?.version === appVersion
  // Signed Windows builds reject unsigned dev installers through publisher validation; entry to dev requires manual download, while returns work normally.
  const needsManualInstall = requiresManualDevChannelInstall({
    platform,
    runningChannel,
    targetChannel: activeChannel
  })

  const handleDownloadInstaller = (build: ReleaseBuild): void => {
    // Fall back to release assets when installer naming is unexpected.
    void window.api.shell.openUrl(build.installerUrl ?? build.releaseUrl)
  }

  const title = t('settings.about.channel.title', 'Channel')
  const platformLabel = t(
    'auto.components.settings.ReleaseChannelSection.devChannelPlatforms',
    DEV_CHANNEL_PLATFORM_LABEL
  )

  return (
    <div data-settings-row="">
      <AboutDisclosureRow
        label={title}
        open={open}
        onOpenChange={setOpen}
        control={
          <Select
            // Until the running channel is known, picking one can't tell "clear the override" from
            // "pin this channel", so the picker waits for it.
            disabled={runningChannel === null}
            // A synced override this platform can't run shows its fallback as a placeholder, so
            // picking that fallback is a real change that clears the override.
            value={activeChannel === requestedChannel ? activeChannel : ''}
            // Selecting the running channel clears the override so browsing cannot permanently pin background checks.
            onValueChange={(value) => {
              const channel = RELEASE_CHANNELS.find((candidate) => candidate === value)
              if (channel) {
                setReleaseChannelOverride(channel === runningChannel ? null : channel)
              }
            }}
          >
            <SelectTrigger size="sm" aria-label={title}>
              <SelectValue placeholder={getReleaseChannelLabel(activeChannel, t)} />
            </SelectTrigger>
            <SelectContent>
              {RELEASE_CHANNELS.map((channel) => {
                const supported = isChannelSupportedOnPlatform(channel, platform)
                return (
                  // Unsupported channels stay listed, disabled, so users can see why they are missing.
                  <SelectItem key={channel} value={channel} disabled={!supported}>
                    {getReleaseChannelLabel(channel, t)}
                    {supported ? null : (
                      <span className="text-muted-foreground">{platformLabel}</span>
                    )}
                  </SelectItem>
                )
              })}
            </SelectContent>
          </Select>
        }
      >
        {/* Narrow rows give the build picker its own line so a build label is never cut short. */}
        <div data-settings-row="" className="@container/build-row">
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex min-w-0 flex-1 @max-xs/build-row:basis-full">
              <ReleaseBuildPicker
                key={activeChannel}
                builds={builds ?? []}
                selectedTag={selectedTag}
                runningVersion={appVersion}
                onSelect={setSelectedTag}
                disabled={loading || !builds || builds.length === 0}
                placeholder={
                  loading || (builds === null && loadError === null)
                    ? t(
                        'auto.components.settings.ReleaseChannelSection.loadingBuilds',
                        'Loading builds…'
                      )
                    : t(
                        'auto.components.settings.ReleaseChannelSection.noBuilds',
                        'No builds found'
                      )
                }
              />
            </div>
            <div className="ms-auto flex items-center gap-2">
              <Button
                variant="ghost"
                size="icon-sm"
                type="button"
                aria-label={t(
                  'auto.components.settings.ReleaseChannelSection.refresh',
                  'Refresh build list'
                )}
                disabled={loading}
                onClick={() =>
                  appVersion === null
                    ? loadVersion()
                    : void loadBuilds(activeChannel, { force: true })
                }
              >
                {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              </Button>
              <Button
                variant="outline"
                size="sm"
                type="button"
                disabled={!selectedBuild || busy || isRunningBuild}
                onClick={() => {
                  if (!selectedBuild) {
                    return
                  }
                  if (needsManualInstall) {
                    handleDownloadInstaller(selectedBuild)
                    return
                  }
                  handleSwitchTo(selectedBuild)
                }}
              >
                {busy ? (
                  <Loader2 className="animate-spin" />
                ) : needsManualInstall ? (
                  <Download />
                ) : null}
                {needsManualInstall
                  ? t(
                      'auto.components.settings.ReleaseChannelSection.downloadInstaller',
                      'Download installer'
                    )
                  : t('settings.about.channel.switch', 'Switch')}
              </Button>
            </div>
          </div>
        </div>
        {loadError ? (
          <p data-settings-row="" className="text-settings-detail text-destructive">
            {updaterMessageText(loadError)}
          </p>
        ) : needsManualInstall && selectedBuild ? (
          <p data-settings-row="" className="text-settings-detail text-muted-foreground">
            {t(
              'auto.components.settings.ReleaseChannelSection.manualInstallHint',
              '{{value0}} builds are unsigned on Windows, so the in-app updater cannot install one over a signed build. Run the downloaded installer once — Windows will warn about an unknown publisher — and every later switch, including back to {{stable}}, works from here.',
              {
                value0: getReleaseChannelLabel(activeChannel, t),
                stable: getReleaseChannelLabel('stable', t)
              }
            )}
          </p>
        ) : selectedBuild && !isRunningBuild ? (
          // A safety warning wraps rather than being cut off.
          <p
            data-settings-row=""
            className="break-words text-settings-detail text-muted-foreground"
          >
            {t(
              'auto.components.settings.ReleaseChannelSection.willSwitch',
              '{{value0}} → {{value1}}',
              { value0: appVersion ?? '…', value1: selectedBuild.version }
            )}
            {' · '}
            {t(
              'settings.about.channel.unvetted',
              'Unvetted builds can break; downgrades are allowed.'
            )}
          </p>
        ) : null}
      </AboutDisclosureRow>
    </div>
  )
}
