import type { BundledSkillPlan } from '../../../../shared/bundled-skill-plan'
import type { BundledSkillTarget } from '@/lib/bundled-skill-target'
import type { ComponentProps, ReactNode } from 'react'
import type { LocalAgentRuntime } from './CliSkillRuntimeSetup'
import type { Button } from '../ui/button'

type AgentSkillSetupPanelVariant = 'card' | 'inline'

export type AgentSkillSetupPanelProps = {
  title: string
  description: ReactNode
  skillNames: readonly string[]
  target?: BundledSkillTarget | null
  // COMPAT(wsl-bridge): removed when WSL runs as an orcad host.
  terminalRuntime?: LocalAgentRuntime
  // An installed copy may use another name (the legacy Linear skill).
  installedSkillNames?: readonly string[]
  installed: boolean
  loading: boolean
  error: string | null
  installDisabled?: boolean
  leading?: ReactNode | ((complete: boolean) => ReactNode)
  icon?: ReactNode
  variant?: AgentSkillSetupPanelVariant
  className?: string
  // Enclosing modals can own the title and status.
  hideHeader?: boolean
  onBeforeInstall?: () => void | Promise<void>
  showInstallWhenInstalled?: boolean
  showRecheckWhenInstalled?: boolean
  installLabel?: string
  installedInstallLabel?: string
  // Modal footers can promote Install to the primary action.
  installVariant?: ComponentProps<typeof Button>['variant']
  actionHint?: ReactNode
  footer?: ReactNode | ((plan: BundledSkillPlan | undefined) => ReactNode)
  onRecheck: () => void | Promise<unknown>
  // Freshness inventory is local-host-only.
  freshnessSkillName?: string
}
