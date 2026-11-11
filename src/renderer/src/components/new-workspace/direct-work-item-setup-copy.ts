import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { WorkspaceSetupLabels } from './workspace-setup-section-model'

export function getDirectWorkspaceSetupLabels(t: Translate = translate): WorkspaceSetupLabels {
  const run = t('components.newWorkspace.directSetup.run', 'Run setup')
  const skip = t('components.newWorkspace.directSetup.skip', 'Skip setup')
  return {
    kinds: {
      setup: {
        configLabel: t('components.newWorkspace.directSetup.setupScript', 'Setup script'),
        askLabel: t('components.newWorkspace.directSetup.askRunSetup', 'Run setup now?'),
        runLabel: run,
        runButtonLabel: run,
        skipButtonLabel: skip
      },
      'default-tabs': {
        configLabel: t(
          'components.newWorkspace.directSetup.defaultTabCommands',
          'Default tab commands'
        ),
        askLabel: t(
          'components.newWorkspace.directSetup.askRunDefaultTabs',
          'Run default tab commands now?'
        ),
        runLabel: run,
        runButtonLabel: run,
        skipButtonLabel: skip
      },
      'setup-and-default-tabs': {
        configLabel: t(
          'components.newWorkspace.directSetup.setupAndDefaultTabs',
          'Setup and default tab commands'
        ),
        askLabel: t(
          'components.newWorkspace.directSetup.askRunSetupAndDefaultTabs',
          'Run setup and default tab commands now?'
        ),
        runLabel: run,
        runButtonLabel: run,
        skipButtonLabel: skip
      }
    },
    sources: {
      yaml: t('components.newWorkspace.directSetup.yamlSource', 'orca.yaml'),
      both: t('components.newWorkspace.directSetup.bothSources', 'orca.yaml + local'),
      local: t('components.newWorkspace.directSetup.localSource', 'local settings')
    },
    help: t(
      'components.newWorkspace.directSetup.description',
      'Choose whether to run setup before creating this workspace.'
    ),
    checking: t(
      'components.newWorkspace.directSetup.description',
      'Choose whether to run setup before creating this workspace.'
    )
  }
}
