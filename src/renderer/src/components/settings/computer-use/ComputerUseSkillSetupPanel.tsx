import { MonitorCog } from 'lucide-react'
import { COMPUTER_USE_SKILL_NAME } from '@/lib/skills/installation/agent-feature-skill-names'
import {
  GLOBAL_AGENT_SKILL_SOURCE_KINDS,
  useInstalledAgentSkill
} from '@/hooks/skills/discovery/useInstalledAgentSkills'
import { useActiveProjectSkillRuntime } from '@/hooks/skills/runtime/useActiveProjectSkillRuntime'
import { useAppStore } from '@/store/index'
import { AgentSkillSetupPanel } from '../../skills/setup/AgentSkillSetupPanel'
import { useTranslate } from '@/i18n/use-translate'

export function ComputerUseSkillSetupPanel(): React.JSX.Element {
  const t = useTranslate()
  const activeSkillRuntime = useActiveProjectSkillRuntime()
  const {
    installed: computerUseSkillDetected,
    loading: computerUseSkillLoading,
    error: computerUseSkillError,
    refresh: refreshComputerUseSkill
  } = useInstalledAgentSkill(COMPUTER_USE_SKILL_NAME, {
    discoveryTarget: activeSkillRuntime.discoveryTarget,
    sourceKinds: GLOBAL_AGENT_SKILL_SOURCE_KINDS
  })

  return (
    <AgentSkillSetupPanel
      variant="inline"
      title={t('auto.components.settings.ComputerUsePane.93255aaf18', 'Orca Computer Use skill')}
      description={t(
        'auto.components.settings.ComputerUsePane.1735461723',
        'Enables agents to inspect and operate local desktop apps.'
      )}
      skillNames={[COMPUTER_USE_SKILL_NAME]}
      installed={computerUseSkillDetected}
      loading={computerUseSkillLoading}
      error={activeSkillRuntime.installDisabledReason ?? computerUseSkillError}
      installDisabled={Boolean(activeSkillRuntime.installDisabledReason)}
      icon={<MonitorCog className="size-5" />}
      onBeforeInstall={() => {
        useAppStore.getState().recordFeatureInteraction('computer-use-setup')
      }}
      onRecheck={refreshComputerUseSkill}
      freshnessSkillName={
        activeSkillRuntime.canUseSkillFreshness ? COMPUTER_USE_SKILL_NAME : undefined
      }
    />
  )
}
