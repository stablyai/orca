export type FeatureWallSetupStepId =
  | 'default-agent'
  | 'add-two-repos'
  | 'notifications'
  | 'split-terminal'
  | 'two-worktrees'
  | 'browser'
  | 'task-sources'
  | 'agent-capabilities'
  | 'setup-script'

export type FeatureWallSetupStep = {
  readonly id: FeatureWallSetupStepId
  readonly name: string
  readonly subtitle: string
  readonly description: string
}

export const FEATURE_WALL_SETUP_PARALLEL_WORK_STEP_IDS = [
  'split-terminal',
  'two-worktrees',
  'browser'
] as const satisfies readonly FeatureWallSetupStepId[]

export type FeatureWallSetupSectionId = 'parallel-work' | 'setup'

export const FEATURE_WALL_SETUP_STEPS: readonly FeatureWallSetupStep[] = [
  {
    id: 'split-terminal',
    name: 'Split a terminal',
    subtitle: 'Split a terminal',
    description:
      'Split a terminal to run two things at once: two agents, an agent next to a dev server, or logs beside a shell.'
  },
  {
    id: 'two-worktrees',
    name: 'Multi-task',
    subtitle: 'Multi-task',
    description:
      'Work in 2 different worktrees at once. Each one is isolated (even in the same project). Perfect for working on 2 features at once.'
  },
  {
    id: 'browser',
    name: "Use Orca's browser",
    subtitle: "Use Orca's browser",
    description:
      'Browse your web app without leaving Orca. Grab any element and send its exact source and styles to an agent with one click.'
  },
  {
    id: 'notifications',
    name: 'Turn on notifications',
    subtitle: 'Turn on notifications',
    description: 'Know the moment an agent finishes, needs attention, or gets blocked.'
  },
  {
    id: 'default-agent',
    name: 'Choose your default agent',
    subtitle: 'Choose your default agent',
    description: 'Start new work faster with your preferred agent already selected.'
  },
  {
    id: 'agent-capabilities',
    name: 'Enable Orca CLI',
    subtitle: 'Enable Orca CLI',
    description:
      'Register the Orca shell command and install agent skills for browser, computer, and orchestration workflows.'
  },
  {
    id: 'task-sources',
    name: 'Connect integrations',
    subtitle: 'Connect integrations',
    description: 'Start an agent from a task in one click and keep PR status in view.'
  },
  {
    id: 'setup-script',
    name: 'Automate workspace setup',
    subtitle: 'Automate workspace setup',
    description:
      'Run install and setup commands automatically so every new worktree is ready for agents.'
  },
  {
    id: 'add-two-repos',
    name: 'Start work in multiple repos',
    subtitle: 'Start work in multiple repos',
    description:
      'Bring your key repos into Orca so you can start agent work without hunting for folders.'
  }
] as const

export const FEATURE_WALL_SETUP_STEP_IDS = FEATURE_WALL_SETUP_STEPS.map((step) => step.id)

export function getFeatureWallSetupSteps(): readonly FeatureWallSetupStep[] {
  return FEATURE_WALL_SETUP_STEPS
}

export function getFeatureWallSetupSectionId(
  stepId: FeatureWallSetupStepId
): FeatureWallSetupSectionId {
  return FEATURE_WALL_SETUP_PARALLEL_WORK_STEP_IDS.includes(
    stepId as (typeof FEATURE_WALL_SETUP_PARALLEL_WORK_STEP_IDS)[number]
  )
    ? 'parallel-work'
    : 'setup'
}

export function getFeatureWallSetupStepsForSection(
  sectionId: FeatureWallSetupSectionId
): readonly FeatureWallSetupStep[] {
  return FEATURE_WALL_SETUP_STEPS.filter(
    (step) => getFeatureWallSetupSectionId(step.id) === sectionId
  )
}

export function getFirstIncompleteFeatureWallSetupStepId(
  stepDone: Partial<Record<FeatureWallSetupStepId, boolean>>
): FeatureWallSetupStepId {
  // Why: onboarding should prioritize Setup, while durable definitions retain the original order.
  const setupStep = getFeatureWallSetupStepsForSection('setup').find((step) => !stepDone[step.id])
  if (setupStep) {
    return setupStep.id
  }
  const parallelStep = getFeatureWallSetupStepsForSection('parallel-work').find(
    (step) => !stepDone[step.id]
  )
  return parallelStep?.id ?? FEATURE_WALL_SETUP_STEPS[0].id
}

export function isFeatureWallSetupStepId(value: unknown): value is FeatureWallSetupStepId {
  return (
    typeof value === 'string' &&
    FEATURE_WALL_SETUP_STEP_IDS.includes(value as FeatureWallSetupStepId)
  )
}
