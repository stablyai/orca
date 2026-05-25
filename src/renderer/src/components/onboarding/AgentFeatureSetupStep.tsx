import { FeatureSetupChecklist } from './FeatureSetupChecklist'
import { FeatureSetupInlineTerminal } from './FeatureSetupInlineTerminal'
import type { OnboardingFeatureSetupSelection } from './onboarding-feature-setup'

type AgentFeatureSetupStepProps = {
  featureSetup: OnboardingFeatureSetupSelection
  onFeatureSetupChange: (value: OnboardingFeatureSetupSelection) => void
  featureSetupCommand: string | null
  featureSetupCommandSelection: OnboardingFeatureSetupSelection | null
}

export function AgentFeatureSetupStep({
  featureSetup,
  onFeatureSetupChange,
  featureSetupCommand,
  featureSetupCommandSelection
}: AgentFeatureSetupStepProps): React.JSX.Element {
  return (
    <>
      <FeatureSetupChecklist value={featureSetup} onChange={onFeatureSetupChange} />
      {featureSetupCommand ? (
        <FeatureSetupInlineTerminal
          command={featureSetupCommand}
          selection={featureSetupCommandSelection ?? featureSetup}
        />
      ) : null}
    </>
  )
}
