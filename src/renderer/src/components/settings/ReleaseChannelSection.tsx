import type React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Apple, Loader2, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { useAppStore } from '../../store'
import { Button } from '../ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { SettingsSegmentedControl, SettingsSubsectionHeader } from './SettingsFormControls'
import { Badge } from '../ui/badge'
import { translate } from '@/i18n/i18n'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import {
  RELEASE_CHANNELS,
  getVersionChannel,
  isChannelSupportedOnPlatform,
  parseHourlyVersionStamp,
  type ReleaseBuild,
  type ReleaseChannel
} from '../../../../shared/release-channel'

const CHANNEL_LABELS: Record<ReleaseChannel, string> = {
  stable: 'Stable',
  rc: 'RC',
  hourly: 'Hourly'
}

const CHANNEL_DESCRIPTIONS: Record<ReleaseChannel, string> = {
  stable: 'Shipped releases. What everyone else is running.',
  rc: 'Release candidates cut ahead of each stable.',
  hourly: 'macOS only. Unvetted builds from main, built every hour. No tests, no notarization.'
}

function formatBuildLabel(build: ReleaseBuild): string {
  // Why the release's own title wins: the hourly workflow composes it
  // (`1.4.163 • 01 • 07-31 13:54 • e698241`), so this row is the same string the
  // GitHub releases list shows — one thing to search for in either place, rather
  // than two renderings of the same build that have to be matched up by eye.
  if (build.name) {
    return build.name
  }
  const stamp = parseHourlyVersionStamp(build.version)
  if (!stamp) {
    return build.version
  }
  // Fallback for hourlies cut before that naming; retention ages them out in ~3
  // days. An hourly's semver tail is an opaque timestamp, so show it as a date.
  return `${build.version.split('-')[0]} · ${stamp.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })}`
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
  // Why: a persisted 'hourly' can arrive on Linux/Windows — settings sync, or a
  // profile carried over from a Mac. Fall back rather than rendering a selected
  // segment the user cannot act on and a build list that can never install.
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

  // Why: two loads can be in flight at once — activeChannel flips on mount when
  // getVersion resolves, and rapid channel clicks stack requests. Without this
  // guard a slower earlier request can land last and fill the list with builds
  // from a channel the picker is no longer showing.
  const latestRequestRef = useRef(0)

  const loadBuilds = useCallback(async (channel: ReleaseChannel): Promise<void> => {
    const requestId = latestRequestRef.current + 1
    latestRequestRef.current = requestId
    const isStale = (): boolean => latestRequestRef.current !== requestId
    setLoading(true)
    setLoadError(null)
    try {
      const result = await window.api.updater.listBuilds(channel)
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
      // Why: only the newest request owns the spinner; a superseded one clearing
      // it would show "no builds" while the current load is still running.
      if (!isStale()) {
        setLoading(false)
      }
    }
  }, [])

  // Why: reload whenever the channel changes so the picker never offers tags
  // from the channel the user just switched away from.
  useEffect(() => {
    setBuilds(null)
    setSelectedTag(null)
    void loadBuilds(activeChannel)
  }, [activeChannel, loadBuilds])

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
          // Why: selecting the running build's own channel clears the override
          // rather than pinning it. Without this there is no way back to "follow
          // this build's channel", so a dev who merely looked at the panel would
          // leave background checks pinned to whatever they last clicked.
          onChange={(channel) =>
            setReleaseChannelOverride(channel === runningChannel ? null : channel)
          }
          ariaLabel={translate(
            'auto.components.settings.ReleaseChannelSection.channelAriaLabel',
            'Update channel'
          )}
          // Why disabled rather than hidden: a Linux/Windows dev who has heard
          // about the hourly channel should see that it exists and why it is
          // unavailable, instead of silently not finding it.
          options={RELEASE_CHANNELS.map((channel) => {
            const supported = isChannelSupportedOnPlatform(channel, platform)
            return {
              value: channel,
              label: supported ? (
                CHANNEL_LABELS[channel]
              ) : (
                <span className="inline-flex items-center gap-1">
                  {CHANNEL_LABELS[channel]}
                  <Apple className="size-3" aria-hidden="true" />
                </span>
              ),
              disabled: !supported,
              ariaLabel: supported
                ? undefined
                : translate(
                    'auto.components.settings.ReleaseChannelSection.hourlyMacOnlyAria',
                    'Hourly (macOS only)'
                  ),
              tooltip: supported
                ? undefined
                : translate(
                    'auto.components.settings.ReleaseChannelSection.hourlyMacOnly',
                    'Hourly builds are produced only for macOS. Linux and Windows stay on Stable or RC.'
                  )
            }
          })}
        />
        <p className="text-xs text-muted-foreground">{CHANNEL_DESCRIPTIONS[activeChannel]}</p>
      </div>

      {activeChannel === 'hourly' ? (
        <div className="flex items-start gap-2 rounded-md border border-border bg-muted/40 p-3">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.ReleaseChannelSection.hourlyWarning',
              'Hourly builds are macOS-only, ship straight from main with no test gate, and are signed but not notarized. Keep a stable build handy.'
            )}
          </p>
        </div>
      ) : null}

      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Select
            value={selectedTag ?? undefined}
            onValueChange={setSelectedTag}
            disabled={loading || !builds || builds.length === 0}
          >
            <SelectTrigger size="sm" className="min-w-64 flex-1">
              <SelectValue
                placeholder={
                  loading
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
            </SelectTrigger>
            <SelectContent>
              {(builds ?? []).map((build) => (
                <SelectItem key={build.tag} value={build.tag}>
                  {formatBuildLabel(build)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Button
            variant="ghost"
            size="icon-sm"
            type="button"
            aria-label={translate(
              'auto.components.settings.ReleaseChannelSection.refresh',
              'Refresh build list'
            )}
            disabled={loading}
            onClick={() => void loadBuilds(activeChannel)}
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
            onClick={() => selectedBuild && handleSwitchTo(selectedBuild)}
          >
            {busy ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              translate(
                'auto.components.settings.ReleaseChannelSection.switchTo',
                'Switch to build'
              )
            )}
          </Button>
        </div>

        {loadError ? (
          <p className="text-xs text-destructive">{loadError}</p>
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
