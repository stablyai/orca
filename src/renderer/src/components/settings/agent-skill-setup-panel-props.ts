import type { ComponentProps, ReactNode } from 'react'
import type { Button } from '../ui/button'

type AgentSkillSetupPanelVariant = 'card' | 'inline'
type SkillPrerequisiteStatus = Awaited<ReturnType<typeof window.api.cli.getInstallStatus>>

export type AgentSkillSetupPanelProps = {
  title: string
  description: ReactNode
  command: string
  installedCommand?: string
  terminalTitle: string
  terminalAriaLabel: string
  terminalWorktreeId: string
  installed: boolean
  loading: boolean
  error: string | null
  installDisabled?: boolean
  terminalHeightPx?: number
  terminalShellOverride?: string
  leading?: ReactNode
  icon?: ReactNode
  variant?: AgentSkillSetupPanelVariant
  className?: string
  // Enclosing modals can own the title and status.
  hideHeader?: boolean
  preInstallNotice?: ReactNode
  getPrerequisiteStatus?: () => Promise<SkillPrerequisiteStatus>
  isPrerequisiteAvailable?: (status: SkillPrerequisiteStatus) => boolean
  onBeforeOpenTerminal?: () => void | Promise<void>
  showInstallWhenInstalled?: boolean
  showRecheckWhenInstalled?: boolean
  installLabel?: string
  installedInstallLabel?: string
  // Modal footers can promote Install to the primary action.
  installVariant?: ComponentProps<typeof Button>['variant']
  actionHint?: ReactNode
  openingHint?: ReactNode
  footer?: ReactNode
  onRecheck: () => void | Promise<unknown>
  // Freshness inventory is local-host-only.
  freshnessSkillName?: string
}
