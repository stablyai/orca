import type {
  FeatureWallSetupStep,
  FeatureWallSetupStepId
} from '../../../../shared/feature-wall-setup-steps'
import { translate } from '@/i18n/i18n'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

type LocalizedFeatureWallSetupChecklistCopy = Pick<FeatureWallSetupStep, 'name' | 'description'>

const getLocalizedFeatureWallSetupChecklistCopyById = createLocalizedCatalog(
  (): Record<FeatureWallSetupStepId, LocalizedFeatureWallSetupChecklistCopy> => ({
    'two-worktrees': {
      name: translate(
        'auto.components.feature.wall.feature.wall.setup.checklist.localized.copy.ec0a363633',
        'Multi-task'
      ),
      description: translate(
        'auto.components.feature.wall.feature.wall.setup.checklist.localized.copy.62bac8f43c',
        'Work in 2 different worktrees at once. Each one is isolated (even in the same project). Perfect for working on 2 features at once.'
      )
    },
    browser: {
      name: translate(
        'auto.components.feature.wall.feature.wall.setup.checklist.localized.copy.908898c3ee',
        "Use Orca's browser"
      ),
      description: translate(
        'auto.components.feature.wall.feature.wall.setup.checklist.localized.copy.43781563c3',
        'Browse your web app without leaving Orca. Grab any element and send its exact source and styles to an agent with one click.'
      )
    },
    notifications: {
      name: translate(
        'auto.components.feature.wall.feature.wall.setup.checklist.localized.copy.29aa2c2077',
        'Turn on notifications'
      ),
      description: translate(
        'auto.components.feature.wall.feature.wall.setup.checklist.localized.copy.71bd9a8c95',
        'Know the moment an agent finishes, needs attention, or gets blocked.'
      )
    },
    'default-agent': {
      name: translate(
        'auto.components.feature.wall.feature.wall.setup.checklist.localized.copy.46db810da8',
        'Choose your default agent'
      ),
      description: translate(
        'auto.components.feature.wall.feature.wall.setup.checklist.localized.copy.b8e5bae17f',
        'Start new work faster with your preferred agent already selected.'
      )
    },
    'agent-capabilities': {
      name: translate(
        'auto.components.feature.wall.feature.wall.setup.checklist.localized.copy.fee5557b02',
        'Enable Orca CLI'
      ),
      description: translate(
        'auto.components.feature.wall.feature.wall.setup.checklist.localized.copy.7bcb4097fa',
        'Register the Orca shell command and install agent skills for browser, computer, and orchestration workflows.'
      )
    },
    'task-sources': {
      name: translate(
        'auto.components.feature.wall.feature.wall.setup.checklist.localized.copy.ad342dd4c6',
        'Connect integrations'
      ),
      description: translate(
        'auto.components.feature.wall.feature.wall.setup.checklist.localized.copy.06fe30fdb0',
        'Start an agent from a task in one click and keep PR status in view.'
      )
    },
    'setup-script': {
      name: translate(
        'auto.components.feature.wall.feature.wall.setup.checklist.localized.copy.eddc532e58',
        'Automate workspace setup'
      ),
      description: translate(
        'auto.components.feature.wall.feature.wall.setup.checklist.localized.copy.56049b74c2',
        'Run install and setup commands automatically so every new worktree is ready for agents.'
      )
    },
    'add-two-repos': {
      name: translate(
        'auto.components.feature.wall.feature.wall.setup.checklist.localized.copy.2cf795433b',
        'Start work in multiple repos'
      ),
      description: translate(
        'auto.components.feature.wall.feature.wall.setup.checklist.localized.copy.42525ba8a4',
        'Bring your key repos into Orca so you can start agent work without hunting for folders.'
      )
    }
  })
)

export function getLocalizedFeatureWallSetupChecklistCopy(
  step: FeatureWallSetupStep
): LocalizedFeatureWallSetupChecklistCopy {
  return getLocalizedFeatureWallSetupChecklistCopyById()[step.id]
}
