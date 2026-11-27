import type { JSX } from 'react'
import { ORCA_CLI_SKILL_NAME } from '@/lib/skills/installation/agent-feature-skill-names'
import { BROWSER_USE_ENABLED_STORAGE_KEY } from '@/lib/browser/browser-use-setup-state'
import type { InstalledAgentSkillState } from '@/hooks/skills/discovery/useInstalledAgentSkills'
import { useActiveProjectSkillRuntime } from '@/hooks/skills/runtime/useActiveProjectSkillRuntime'
import { AgentSkillSetupPanel } from '@/components/skills/setup/AgentSkillSetupPanel'
import { useAppStore } from '@/store/index'
import { useTranslate } from '@/i18n/use-translate'
import { useOrcaTeamFeatureBlocked } from '@/lib/orca-team-policy'
import { ORCA_CLOUD_TEAM_POLICY_FLAGS } from '../../../../../../shared/orca-profiles/orca-cloud-team-policy'

export function BrowserUseSkillSetupCard(props: {
  compact?: boolean
  skill: InstalledAgentSkillState
}): JSX.Element | null {
  const t = useTranslate()
  const blocked = useOrcaTeamFeatureBlocked(ORCA_CLOUD_TEAM_POLICY_FLAGS.browserUse)
  const { compact, skill } = props
  const activeSkillRuntime = useActiveProjectSkillRuntime()
  if (blocked) {
    return null
  }

  const handleBeforeInstall = (): void => {
    useAppStore.getState().recordFeatureInteraction('agent-browser-setup')
    localStorage.setItem(BROWSER_USE_ENABLED_STORAGE_KEY, '1')
  }

  const setupPanel = (
    <AgentSkillSetupPanel
      className={compact ? 'w-full max-w-[520px]' : undefined}
      title={t(
        'auto.components.feature.wall.BrowserUseSkillSetupCard.d5bb1cd4ba',
        'Browser Use skill'
      )}
      description={t(
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
