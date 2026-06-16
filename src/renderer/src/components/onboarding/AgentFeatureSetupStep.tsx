import { Loader2, Terminal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { FeatureSetupChecklist } from './FeatureSetupChecklist'
import { FeatureSetupInlineTerminal } from './FeatureSetupInlineTerminal'
import {
  hasSelectedOnboardingFeatureSetup,
  type OnboardingFeatureSetupSelection
} from './onboarding-feature-setup'
import { translate } from '@/i18n/i18n'

type AgentFeatureSetupStepProps = {
  featureSetup: OnboardingFeatureSetupSelection
  onFeatureSetupChange: (value: OnboardingFeatureSetupSelection) => void
  featureSetupCommand: string | null
  featureSetupCommandSelection: OnboardingFeatureSetupSelection | null
  setupBusyLabel: string | null
  onStartFeatureSetup: () => void
}

export function AgentFeatureSetupStep({
  featureSetup,
  onFeatureSetupChange,
  featureSetupCommand,
  featureSetupCommandSelection,
  setupBusyLabel,
  onStartFeatureSetup
}: AgentFeatureSetupStepProps): React.JSX.Element {
  const hasSelectedFeatures = hasSelectedOnboardingFeatureSetup(featureSetup)
  const showSetupAction = !featureSetupCommand

  return (
    <>
      <FeatureSetupChecklist value={featureSetup} onChange={onFeatureSetupChange} />
      {showSetupAction ? (
        <div className="mt-4 flex items-center">
          <Button
            type="button"
            variant="default"
            className="shrink-0"
            disabled={!hasSelectedFeatures || Boolean(setupBusyLabel)}
            onClick={onStartFeatureSetup}
          >
            {setupBusyLabel ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Terminal className="size-4" />
            )}
            {setupBusyLabel ??
              translate(
                'auto.components.onboarding.AgentFeatureSetupStep.97dcdc010f',
                'Install CLI & Skills'
              )}
          </Button>
        </div>
      ) : null}
      {featureSetupCommand ? (
        <FeatureSetupInlineTerminal
          command={featureSetupCommand}
          selection={featureSetupCommandSelection ?? featureSetup}
        />
      ) : null}
    </>
  )
}
