import type { ReactNode } from 'react'
import { Globe2, MonitorCog, Workflow } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import type { OnboardingFeatureSetupId } from '../../../onboarding/onboarding-feature-setup'

type AgentCapabilitySetupRow = {
  id: OnboardingFeatureSetupId
  title: string
  description: string
  icon: ReactNode
}

export const AGENT_CAPABILITY_SETUP_ROWS: readonly AgentCapabilitySetupRow[] = [
  {
    id: 'orchestration',
    get title() {
      return translate(
        'auto.components.feature.wall.AgentCapabilitiesSetupAction.ac07f8887f',
        'Agent Orchestration'
      )
    },
    get description() {
      return translate(
        'auto.components.feature.wall.AgentCapabilitiesSetupAction.c61c91e642',
        'Let agents coordinate through Orca to keep large, multi-step tasks moving to completion.'
      )
    },
    icon: <Workflow className="size-4" />
  },
  {
    id: 'browserUse',
    get title() {
      return translate(
        'auto.components.feature.wall.AgentCapabilitiesSetupAction.e638da007a',
        'Agent Browser Use'
      )
    },
    get description() {
      return translate(
        'auto.components.feature.wall.AgentCapabilitiesSetupAction.5e8fe5a72d',
        "Give agents direct access to Orca's browser so they can test pages, capture screenshots, and act on what they see."
      )
    },
    icon: <Globe2 className="size-4" />
  },
  {
    id: 'computerUse',
    get title() {
      return translate(
        'auto.components.feature.wall.AgentCapabilitiesSetupAction.362a07517d',
        'Computer Use'
      )
    },
    get description() {
      return translate(
        'auto.components.feature.wall.AgentCapabilitiesSetupAction.1b51644c2d',
        'Let agents control the desktop, moving the cursor, clicking, and typing in any app.'
      )
    },
    icon: <MonitorCog className="size-4" />
  }
]
