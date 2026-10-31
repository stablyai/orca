import { useTranslation } from 'react-i18next'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { i18n, loadRendererUiLanguage } from '@/i18n/i18n'
import { planOf, sharedEntry } from '../skills/bundled-skill-plan-fixtures.test-support'
import { AgentSkillSetupPanel } from './AgentSkillSetupPanel'

function InstalledSkill(): React.JSX.Element {
  useTranslation()
  return (
    <div className="bg-background p-4 text-foreground">
      <AgentSkillSetupPanel
        title="Orchestration skill"
        description="Enable agents to coordinate work through Orca."
        skillNames={['orchestration']}
        installed
        loading={false}
        error={null}
        onRecheck={() => {}}
      />
    </div>
  )
}

export const installed = defineFixture({
  width: 600,
  store: { runtimeEnvironmentCatalogSettled: true },
  setup: () => {
    window.api.skills.bundledPlan = async () =>
      planOf([sharedEntry('orchestration', 'keep', { agents: ['codex', 'claude'] })])
  },
  render: () => <InstalledSkill />,
  interact: async () => {
    await i18n.changeLanguage(await loadRendererUiLanguage('en'))
  }
})
