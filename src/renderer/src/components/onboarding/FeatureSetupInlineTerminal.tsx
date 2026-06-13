import { useCallback, useMemo, useRef, type KeyboardEvent } from 'react'
import { track } from '@/lib/telemetry'
import { notifyInstalledAgentSkillsChanged } from '@/hooks/useInstalledAgentSkills'
import { OnboardingInlineCommandTerminal } from './OnboardingInlineCommandTerminal'
import {
  onboardingFeatureSetupTelemetrySelection,
  type OnboardingFeatureSetupSelection
} from './onboarding-feature-setup'
import { translate } from '@/i18n/i18n'

type FeatureSetupInlineTerminalProps = {
  command: string
  selection: OnboardingFeatureSetupSelection
}

export function FeatureSetupInlineTerminal({
  command,
  selection
}: FeatureSetupInlineTerminalProps): React.JSX.Element {
  const terminalOpenedTrackedRef = useRef(false)
  const terminalInteractedTrackedRef = useRef(false)

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
