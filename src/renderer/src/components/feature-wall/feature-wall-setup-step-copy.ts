import { translate } from '@/i18n/i18n'
import type {
  FeatureWallSetupStep,
  FeatureWallSetupStepId
} from '../../../../shared/feature-wall-setup-steps'

const STEP_COPY: Record<
  FeatureWallSetupStepId,
  { nameKey: string; name: string; descriptionKey: string; description: string }
> = {
  notifications: {
    nameKey: 'auto.components.feature.wall.setupSteps.notifications.name',
    name: 'Turn on notifications',
    descriptionKey: 'auto.components.feature.wall.setupSteps.notifications.description',
    description: 'Know the moment an agent finishes, needs attention, or gets blocked.'
  },
  'default-agent': {
    nameKey: 'auto.components.feature.wall.setupSteps.defaultAgent.name',
    name: 'Choose your default agent',
    descriptionKey: 'auto.components.feature.wall.setupSteps.defaultAgent.description',
    description: 'Start new work faster with your preferred agent already selected.'
  },
  'agent-capabilities': {
    nameKey: 'auto.components.feature.wall.setupSteps.agentCapabilities.name',
    name: 'Enable Orca CLI',
    descriptionKey: 'auto.components.feature.wall.setupSteps.agentCapabilities.description',
    description:
      'Register the Orca shell command and install agent skills for browser, computer, and orchestration workflows.'
  },
  'task-sources': {
    nameKey: 'auto.components.feature.wall.setupSteps.taskSources.name',
    name: 'Connect integrations',
    descriptionKey: 'auto.components.feature.wall.setupSteps.taskSources.description',
    description: 'Start an agent from a task in one click and keep PR status in view.'
  },
  'setup-script': {
    nameKey: 'auto.components.feature.wall.setupSteps.setupScript.name',
    name: 'Automate workspace setup',
    descriptionKey: 'auto.components.feature.wall.setupSteps.setupScript.description',
    description:
      'Run install and setup commands automatically so every new worktree is ready for agents.'
  },
  'add-two-repos': {
    nameKey: 'auto.components.feature.wall.setupSteps.addTwoRepos.name',
    name: 'Start work in multiple repos',
    descriptionKey: 'auto.components.feature.wall.setupSteps.addTwoRepos.description',
    description:
      'Bring your key repos into Orca so you can start agent work without hunting for folders.'
  },
  'two-worktrees': {
    nameKey: 'auto.components.feature.wall.setupSteps.twoWorktrees.name',
    name: 'Multi-task',
    descriptionKey: 'auto.components.feature.wall.setupSteps.twoWorktrees.description',
    description:
      'Work in 2 different worktrees at once. Each one is isolated (even in the same project). Perfect for working on 2 features at once.'
  },
  browser: {
    nameKey: 'auto.components.feature.wall.setupSteps.browser.name',
    name: "Use Orca's browser",
    descriptionKey: 'auto.components.feature.wall.setupSteps.browser.description',
    description:
      'Browse your web app without leaving Orca. Grab any element and send its exact source and styles to an agent with one click.'
  }
}

export function localizeFeatureWallSetupStep(step: FeatureWallSetupStep): FeatureWallSetupStep {
  const copy = STEP_COPY[step.id]
  if (!copy) {
    return step
  }
  const name = translate(copy.nameKey, copy.name)
  return {
    ...step,
    name,
    subtitle: name,
    description: translate(copy.descriptionKey, copy.description)
  }
}
