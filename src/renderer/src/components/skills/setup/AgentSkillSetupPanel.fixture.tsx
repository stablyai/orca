import { useTranslation } from 'react-i18next'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import { i18n, loadRendererUiLanguage } from '@/i18n/i18n'
import { planOf, sharedEntry } from '../bundled-skill-plan-fixtures.test-support'
import { AgentSkillSetupPanel } from './AgentSkillSetupPanel'
import { useAppStore } from '@/store'
import { ConfirmationDialogProvider } from '@/components/confirmation-dialog'
import { CliSetupTipDialog } from '../../feature-tips/CliSetupTipDialog'
import SkillsPage from '../SkillsPage'
import { FEATURE_TIPS } from '../../../../../shared/feature-tips'
import type { SkillDiscoveryResult } from '../../../../../shared/skills'

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

const installedNames = ['orca-cli', 'orchestration']
const inventory: SkillDiscoveryResult = {
  scannedAt: 1,
  sources: [
    {
      id: 'shared',
      label: 'Agent skills',
      path: '/home/dev/.agents/skills',
      sourceKind: 'home',
      providers: ['agent-skills'],
      owner: null,
      exists: true
    }
  ],
  skills: installedNames.map((name) => ({
    id: name,
    name,
    description: 'Coordinate local agent work with Orca.',
    providers: ['agent-skills'],
    sourceKind: 'home',
    sourceLabel: 'Agent skills',
    rootPath: '/home/dev/.agents/skills',
    directoryPath: `/home/dev/.agents/skills/${name}`,
    skillFilePath: `/home/dev/.agents/skills/${name}/SKILL.md`,
    installed: true,
    updatedAt: null
  }))
}

async function setupTipSkills() {
  await i18n.changeLanguage(await loadRendererUiLanguage('en'))
  window.api.skills.bundledPlan = async () =>
    planOf(installedNames.map((name) => sharedEntry(name, 'keep', { agents: ['codex', 'claude'] })))
  window.api.skills.discover = async () => inventory
  window.api.skills.deleteSupported = async () => true
  window.api.skills.listOwnedShares = async () => ({ status: 'ok', value: [] })
}

function SkillManagerNavigation(): React.JSX.Element {
  const activeView = useAppStore((state) => state.activeView)
  const activeModal = useAppStore((state) => state.activeModal)
  const closeModal = useAppStore((state) => state.closeModal)
  const tip = FEATURE_TIPS.find((entry) => entry.id === 'orca-cli')
  if (!tip) {
    throw new Error('Missing CLI feature tip')
  }
  return (
    <ConfirmationDialogProvider>
      <div className="flex h-[900px] flex-col bg-background text-foreground">
        {activeView === 'skills' ? <SkillsPage /> : <InstalledSkill />}
        <CliSetupTipDialog
          open={activeModal === 'feature-tips'}
          tip={tip}
          primaryBusy={false}
          skillTerminalOpen
          onOpenChange={(open) => {
            if (!open) {
              closeModal()
            }
          }}
          onPrimaryAction={() => {}}
          onSkip={closeModal}
        />
      </div>
    </ConfirmationDialogProvider>
  )
}

export const fromTip = defineFixture({
  width: 1280,
  store: {
    activeView: 'terminal',
    activeModal: 'feature-tips',
    runtimeEnvironmentCatalogSettled: true
  },
  setup: setupTipSkills,
  render: () => <SkillManagerNavigation />
})

export const fromTipAfterOpen = defineFixture({
  width: 1280,
  store: {
    activeView: 'terminal',
    activeModal: 'feature-tips',
    runtimeEnvironmentCatalogSettled: true
  },
  setup: setupTipSkills,
  render: () => <SkillManagerNavigation />,
  interact: async () => {
    let button: HTMLButtonElement | undefined
    for (let i = 0; i < 60; i++) {
      button = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
        (entry) => entry.textContent?.trim() === 'Open Skills'
      )
      if (button) {
        break
      }
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    }
    if (!button) {
      throw new Error('Installed skill manager action did not appear')
    }
    button.click()
    for (let i = 0; i < 20; i++) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    }
    if (useAppStore.getState().activeView !== 'skills') {
      throw new Error('Skills page did not open')
    }
  }
})
