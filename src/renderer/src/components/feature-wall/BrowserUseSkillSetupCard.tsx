import type { JSX } from 'react'
import { ORCA_CLI_SKILL_NAME } from '@/lib/agent-feature-skill-names'
import { BROWSER_USE_ENABLED_STORAGE_KEY } from '@/lib/browser-use-setup-state'
import type { InstalledAgentSkillState } from '@/hooks/useInstalledAgentSkills'
import { useActiveProjectSkillRuntime } from '@/hooks/useActiveProjectSkillRuntime'
import { AgentSkillSetupPanel } from '@/components/settings/AgentSkillSetupPanel'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'

export function BrowserUseSkillSetupCard(props: {
  compact?: boolean
  skill: InstalledAgentSkillState
}): JSX.Element {
  const { compact, skill } = props
  const activeSkillRuntime = useActiveProjectSkillRuntime()

  const handleBeforeInstall = (): void => {
    useAppStore.getState().recordFeatureInteraction('agent-browser-setup')
    localStorage.setItem(BROWSER_USE_ENABLED_STORAGE_KEY, '1')
  }

  const setupPanel = (
    <AgentSkillSetupPanel
      className={compact ? 'w-full max-w-[520px]' : undefined}
      title={translate(
        'auto.components.feature.wall.BrowserUseSkillSetupCard.d5bb1cd4ba',
        'Browser Use skill'
      )}
      description={translate(
        'auto.components.feature.wall.BrowserUseSkillSetupCard.cbc45022d4',
        "Enables agents to navigate and verify pages in Orca's browser."
      )}
      skillNames={[ORCA_CLI_SKILL_NAME]}
      installed={skill.installed}
      loading={skill.loading}
      error={activeSkillRuntime.installDisabledReason ?? skill.error}
      installDisabled={Boolean(activeSkillRuntime.installDisabledReason)}
      onBeforeInstall={handleBeforeInstall}
      showRecheckWhenInstalled={false}
      onRecheck={skill.refresh}
      freshnessSkillName={activeSkillRuntime.canUseSkillFreshness ? ORCA_CLI_SKILL_NAME : undefined}
    />
  )

  if (compact) {
    return <div className="flex min-h-24 flex-1 items-center justify-center pt-3">{setupPanel}</div>
  }
  return <div className="flex">{setupPanel}</div>
}
