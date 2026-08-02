import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { ExternalLink, Loader2, RefreshCw, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { getRendererAppPlatform } from '@/lib/renderer-app-platform'
import { track } from '@/lib/telemetry'
import { notifyInstalledAgentSkillsChanged } from '@/hooks/useInstalledAgentSkills'
import { useAppStore } from '@/store'
import { OnboardingInlineCommandTerminal } from './OnboardingInlineCommandTerminal'
import {
  onboardingFeatureSetupTelemetrySelection,
  type OnboardingFeatureSetupSelection
} from './onboarding-feature-setup'
import { getFeatureSetupNpxPreflightContext } from './feature-setup-npx-preflight'
import { translate } from '@/i18n/i18n'

type FeatureSetupInlineTerminalProps = {
  command: string
  selection: OnboardingFeatureSetupSelection
}

type NpxProbeStatus = 'checking' | 'available' | 'missing'

export function FeatureSetupInlineTerminal({
  command,
  selection
}: FeatureSetupInlineTerminalProps): React.JSX.Element {
  const terminalOpenedTrackedRef = useRef(false)
  const terminalInteractedTrackedRef = useRef(false)
  const activeRuntimeEnvironmentId = useAppStore((s) => s.settings?.activeRuntimeEnvironmentId)
  const terminalWindowsShell = useAppStore((s) => s.settings?.terminalWindowsShell)
  const terminalWindowsWslDistro = useAppStore((s) => s.settings?.terminalWindowsWslDistro)
  const isRemoteRuntimeFocused = Boolean(activeRuntimeEnvironmentId?.trim())
  const platform = getRendererAppPlatform()
  const [probeRevision, setProbeRevision] = useState(0)
  const probeKey = [
    isRemoteRuntimeFocused,
    platform,
    terminalWindowsShell,
    terminalWindowsWslDistro,
    probeRevision
  ].join(':')
  const initialProbeStatus = isRemoteRuntimeFocused ? 'available' : 'checking'
  const [npxProbe, setNpxProbe] = useState<{ key: string; status: NpxProbeStatus }>({
    key: probeKey,
    status: initialProbeStatus
  })
  const npxProbeRequestRef = useRef<{ key: string; promise: Promise<boolean> } | null>(null)

  if (npxProbe.key !== probeKey) {
    setNpxProbe({ key: probeKey, status: initialProbeStatus })
  }

  useEffect(() => {
    if (isRemoteRuntimeFocused) {
      npxProbeRequestRef.current = null
      return
    }
    let cancelled = false
    const context = getFeatureSetupNpxPreflightContext(
      platform,
      terminalWindowsShell,
      terminalWindowsWslDistro
    )
    const existingRequest = npxProbeRequestRef.current
    const request =
      existingRequest?.key === probeKey
        ? existingRequest.promise
        : window.api.skills.isNpxOnPath(context, { forceRefresh: probeRevision > 0 })
    if (request !== existingRequest?.promise) {
      npxProbeRequestRef.current = { key: probeKey, promise: request }
    }
    void request.then(
      (onPath) => {
        if (!cancelled) {
          setNpxProbe({ key: probeKey, status: onPath ? 'available' : 'missing' })
        }
      },
      () => {
        if (!cancelled) {
          setNpxProbe({ key: probeKey, status: 'available' })
        }
      }
    )
    return () => {
      cancelled = true
    }
  }, [
    isRemoteRuntimeFocused,
    platform,
    probeKey,
    probeRevision,
    terminalWindowsShell,
    terminalWindowsWslDistro
  ])

  const selectionTelemetry = useMemo(
    () => onboardingFeatureSetupTelemetrySelection(selection),
    [selection]
  )

  const trackTerminalOpened = useCallback(() => {
    if (terminalOpenedTrackedRef.current) {
      return
    }
    terminalOpenedTrackedRef.current = true
    track('onboarding_feature_setup_terminal_opened', selectionTelemetry)
  }, [selectionTelemetry])

  const trackTerminalInteraction = useCallback(
    (method: 'keyboard' | 'pointer', event?: KeyboardEvent<HTMLElement>) => {
      if (terminalInteractedTrackedRef.current) {
        return
      }
      const isMac = navigator.userAgent.includes('Mac')
      const isContinueShortcut = event?.key === 'Enter' && (isMac ? event.metaKey : event.ctrlKey)
      if (isContinueShortcut) {
        return
      }
      // Why: auto-insert focuses the terminal programmatically; only count
      // direct terminal activity, not the global continue shortcut.
      terminalInteractedTrackedRef.current = true
      track('onboarding_feature_setup_terminal_interacted', {
        ...selectionTelemetry,
        method
      })
    },
    [selectionTelemetry]
  )

  if (npxProbe.status === 'checking') {
    return (
      <div
        role="status"
        className="mt-4 flex min-h-24 items-center justify-center gap-2 rounded-xl border border-border bg-card text-sm text-muted-foreground"
      >
        <Loader2 className="size-4 animate-spin" />
        {translate(
          'auto.components.onboarding.FeatureSetupInlineTerminal.checkingNpx',
          'Checking for npx…'
        )}
      </div>
    )
  }

  if (npxProbe.status === 'missing') {
    return (
      <section className="mt-4 rounded-xl border border-border bg-card p-4" aria-live="polite">
        <div className="flex items-start gap-3">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
          <div className="min-w-0">
            <h3 className="text-sm font-medium text-foreground">
              {translate(
                'auto.components.onboarding.FeatureSetupInlineTerminal.npxMissingTitle',
                'Node.js is required'
              )}
            </h3>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              {translate(
                'auto.components.onboarding.FeatureSetupInlineTerminal.npxMissingNotice',
                'npx was not found in this terminal environment. Install Node.js LTS, then re-check to continue skill setup.'
              )}
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                onClick={() => void window.api.shell.openUrl('https://nodejs.org/')}
              >
                <ExternalLink className="size-3.5" />
                {translate(
                  'auto.components.onboarding.FeatureSetupInlineTerminal.downloadNode',
                  'Download Node.js'
                )}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setProbeRevision((revision) => revision + 1)}
              >
                <RefreshCw className="size-3.5" />
                {translate(
                  'auto.components.onboarding.FeatureSetupInlineTerminal.recheckNpx',
                  'Re-check'
                )}
              </Button>
            </div>
          </div>
        </div>
      </section>
    )
  }

  return (
    <OnboardingInlineCommandTerminal
      command={command}
      title={translate(
        'auto.components.onboarding.FeatureSetupInlineTerminal.c767ab7061',
        'Skill setup'
      )}
      ariaLabel={translate(
        'auto.components.onboarding.FeatureSetupInlineTerminal.47fc6cc6dc',
        'Skill setup command'
      )}
      description={translate(
        'auto.components.onboarding.FeatureSetupInlineTerminal.789b59936e',
        'Press Enter to run the command and confirm npx if asked. You can also set this up later in Settings.'
      )}
      terminalHeightPx={180}
      terminalTopMarginPx={16}
      autoScrollIntoView={false}
      onOpened={trackTerminalOpened}
      onInteracted={trackTerminalInteraction}
      onTerminalExit={notifyInstalledAgentSkillsChanged}
    />
  )
}
