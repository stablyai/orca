import type React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Download, Loader2, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { useAppStore } from '../../store'
import { Button } from '../ui/button'
import { ReleaseBuildPicker } from './ReleaseBuildPicker'
import { SettingsSegmentedControl, SettingsSubsectionHeader } from './SettingsFormControls'
import { Badge } from '../ui/badge'
import { translate } from '@/i18n/i18n'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import {
  DEV_CHANNEL_PLATFORM_LABEL,
  RELEASE_CHANNELS,
  RELEASE_CHANNEL_LABELS,
  getVersionChannel,
  hasDedicatedReleaseRepo,
  isChannelSupportedOnPlatform,
  requiresManualDevChannelInstall,
  type DedicatedRepoChannel,
  type ReleaseBuild,
  type ReleaseChannel
} from '../../../../shared/release-channel'

const CHANNEL_DESCRIPTIONS: Record<ReleaseChannel, string> = {
  stable: 'Shipped releases. What everyone else is running.',
  rc: 'Release candidates cut ahead of each stable.',
  hourly: 'macOS and Windows. Unvetted builds from main, built every hour. No tests.',
  daily:
    'macOS and Windows. Unvetted builds from main, cut once a day at 14:15 UTC (early morning Pacific). No tests.',
  adhoc: 'macOS and Windows. One-off builds cut from a branch to try a feature before it lands.'
}

const DEDICATED_CHANNEL_WARNINGS: Record<DedicatedRepoChannel, { key: string; fallback: string }> =
  {
    hourly: {
      key: 'auto.components.settings.ReleaseChannelSection.hourlyWarning',
      fallback:
        'Hourly builds ship straight from main with no test gate, and the Windows ones are unsigned. Keep a stable build handy.'
    },
    daily: {
      key: 'auto.components.settings.ReleaseChannelSection.dailyWarning',
      fallback:
        'Daily builds ship straight from main with no test gate, and the Windows ones are unsigned. Keep a stable build handy.'
    },
    adhoc: {
      key: 'auto.components.settings.ReleaseChannelSection.adhocWarning',
      fallback:
        'Adhoc builds come from a branch that has not landed, and the Windows ones are unsigned. Whoever cut one may abandon it — keep a stable build handy.'
    }
  }

export function ReleaseChannelSection(): React.JSX.Element {
  const updateStatus = useAppStore((s) => s.updateStatus)
  const releaseChannelOverride = useAppStore((s) => s.releaseChannelOverride)
  const setReleaseChannelOverride = useAppStore((s) => s.setReleaseChannelOverride)

  const [appVersion, setAppVersion] = useState<string | null>(null)
  const [builds, setBuilds] = useState<ReleaseBuild[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [selectedTag, setSelectedTag] = useState<string | null>(null)

  const platform = getShortcutPlatform()
  const runningChannel = appVersion ? getVersionChannel(appVersion) : null
  const requestedChannel = releaseChannelOverride ?? runningChannel ?? 'stable'
  // Synced Mac profiles can carry unsupported hourly channels; fall back instead of offering uninstallable builds.
  const activeChannel = isChannelSupportedOnPlatform(requestedChannel, platform)
    ? requestedChannel
    : 'stable'
  const busy = updateStatus.state === 'checking' || updateStatus.state === 'downloading'

  useEffect(() => {
    let cancelled = false
    void window.api.updater.getVersion().then((version) => {
      if (!cancelled) {
        setAppVersion(version)
      }
    })
    return () => {
      cancelled = true
    }
  }, [])

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
          setLoadError(result.message)
        }
      } catch (error) {
        if (isStale()) {
          return
        }
        setBuilds(null)
        setLoadError(String((error as Error)?.message ?? error))
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
          translate(
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

  return (
    <section className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <SettingsSubsectionHeader
          title={translate(
            'auto.components.settings.ReleaseChannelSection.title',
            'Release channel'
          )}
          description={translate(
            'auto.components.settings.ReleaseChannelSection.description',
            'Switch update channels or jump to any published build, including older ones. Downgrades are allowed and unvetted builds can be broken.'
          )}
        />
        <Badge variant="outline" className="mt-0.5 shrink-0">
          {translate('auto.components.settings.ReleaseChannelSection.devOnly', 'Dev only')}
        </Badge>
      </div>

      <div className="space-y-2">
        <SettingsSegmentedControl<ReleaseChannel>
          value={activeChannel}
          // Selecting the running channel clears the override so browsing cannot permanently pin background checks.
          onChange={(channel) =>
            setReleaseChannelOverride(channel === runningChannel ? null : channel)
          }
          ariaLabel={translate(
            'auto.components.settings.ReleaseChannelSection.channelAriaLabel',
            'Update channel'
          )}
          // Show unsupported channels disabled with reasons so users can discover why they are unavailable.
          options={RELEASE_CHANNELS.map((channel) => {
            const supported = isChannelSupportedOnPlatform(channel, platform)
            return {
              value: channel,
              label: RELEASE_CHANNEL_LABELS[channel],
              disabled: !supported,
              ariaLabel: supported
                ? undefined
                : translate(
                    'auto.components.settings.ReleaseChannelSection.devChannelUnsupportedAria',
                    '{{value0}} ({{value1}} only)',
                    { value0: RELEASE_CHANNEL_LABELS[channel], value1: DEV_CHANNEL_PLATFORM_LABEL }
                  ),
              tooltip: supported
                ? undefined
                : translate(
                    'auto.components.settings.ReleaseChannelSection.devChannelUnsupported',
                    '{{value0}} builds are produced only for {{value1}}. Linux stays on Stable or RC.',
                    { value0: RELEASE_CHANNEL_LABELS[channel], value1: DEV_CHANNEL_PLATFORM_LABEL }
                  )
            }
          })}
        />
        <p className="text-xs text-muted-foreground">{CHANNEL_DESCRIPTIONS[activeChannel]}</p>
      </div>

      {hasDedicatedReleaseRepo(activeChannel) ? (
        <div className="flex items-start gap-2 rounded-md border border-border bg-muted/40 p-3">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
          <p className="text-xs text-muted-foreground">
            {translate(
              DEDICATED_CHANNEL_WARNINGS[activeChannel].key,
              DEDICATED_CHANNEL_WARNINGS[activeChannel].fallback
            )}
          </p>
        </div>
      ) : null}

      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <ReleaseBuildPicker
            key={activeChannel}
            builds={builds ?? []}
            selectedTag={selectedTag}
            onSelect={setSelectedTag}
            disabled={loading || !builds || builds.length === 0}
            placeholder={
              loading || (builds === null && loadError === null)
                ? translate(
                    'auto.components.settings.ReleaseChannelSection.loadingBuilds',
                    'Loading builds…'
                  )
                : translate(
                    'auto.components.settings.ReleaseChannelSection.noBuilds',
                    'No builds found'
                  )
            }
          />

          <Button
            variant="ghost"
            size="icon-sm"
            type="button"
            aria-label={translate(
              'auto.components.settings.ReleaseChannelSection.refresh',
              'Refresh build list'
            )}
            disabled={loading}
            onClick={() => void loadBuilds(activeChannel, { force: true })}
          >
            {loading ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <RefreshCw className="size-3.5" />
            )}
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
              <Loader2 className="size-3.5 animate-spin" />
            ) : needsManualInstall ? (
              <span className="inline-flex items-center gap-1.5">
                <Download className="size-3.5" aria-hidden="true" />
                {translate(
                  'auto.components.settings.ReleaseChannelSection.downloadInstaller',
                  'Download installer'
                )}
              </span>
            ) : (
              translate(
                'auto.components.settings.ReleaseChannelSection.switchTo',
                'Switch to build'
              )
            )}
          </Button>
        </div>

        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.ReleaseChannelSection.cacheHint',
            'Build lists are cached for 5 minutes. Refresh to check for new builds.'
          )}
        </p>

        {loadError ? (
          <p className="text-xs text-destructive">{loadError}</p>
        ) : needsManualInstall && selectedBuild ? (
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.ReleaseChannelSection.manualInstallHint',
              '{{value0}} builds are unsigned on Windows, so the in-app updater cannot install one over a signed build. Run the downloaded installer once — Windows will warn about an unknown publisher — and every later switch, including back to Stable, works from here.',
              { value0: RELEASE_CHANNEL_LABELS[activeChannel] }
            )}
          </p>
        ) : isRunningBuild ? (
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.ReleaseChannelSection.alreadyRunning',
              'This is the build you are running.'
            )}
          </p>
        ) : selectedBuild ? (
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.ReleaseChannelSection.willSwitch',
              '{{value0}} → {{value1}}',
              { value0: appVersion ?? '…', value1: selectedBuild.version }
            )}
          </p>
        ) : null}
      </div>
    </section>
  )
}
