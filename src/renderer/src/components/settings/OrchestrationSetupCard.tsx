import type { JSX } from 'react'
import { ORCHESTRATION_SKILL_NAME } from '@/lib/agent-feature-skill-names'
import type { InstalledAgentSkillState } from '@/hooks/useInstalledAgentSkills'
import { useActiveProjectSkillRuntime } from '@/hooks/useActiveProjectSkillRuntime'
import { AgentSkillSetupPanel } from './AgentSkillSetupPanel'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'

export function OrchestrationSetupCard(props: {
  compact?: boolean
  skill: InstalledAgentSkillState
}): JSX.Element {
  const { compact, skill } = props
  const activeSkillRuntime = useActiveProjectSkillRuntime()

  const setupPanel = (
    <AgentSkillSetupPanel
      className={compact ? 'w-full max-w-[520px]' : undefined}
      title={translate(
        'auto.components.settings.OrchestrationSetupCard.2777ff0fdc',
        'Orchestration skill'
      )}
      description={translate(
        'auto.components.settings.OrchestrationSetupCard.e7d2a5146c',
        'Enables agents to hand off context and coordinate work through Orca.'
      )}
      skillNames={[ORCHESTRATION_SKILL_NAME]}
      installed={skill.installed}
      loading={skill.loading}
      error={activeSkillRuntime.installDisabledReason ?? skill.error}
      installDisabled={Boolean(activeSkillRuntime.installDisabledReason)}
      onBeforeInstall={() => {
        useAppStore.getState().recordFeatureInteraction('agent-orchestration-setup')
      }}
      onRecheck={skill.refresh}
      freshnessSkillName={
        activeSkillRuntime.canUseSkillFreshness ? ORCHESTRATION_SKILL_NAME : undefined
      }
    />
  )

  if (compact) {
    return <div className="flex min-h-24 flex-1 items-center justify-center">{setupPanel}</div>
  }
  return <div className="flex">{setupPanel}</div>
}
