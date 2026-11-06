import { translate } from '@/i18n/i18n'
import type { WorkspaceSetupLabels } from './workspace-setup-section-model'

export function getDirectWorkspaceSetupLabels(): WorkspaceSetupLabels {
  const run = translate('components.newWorkspace.directSetup.run', 'Run setup')
  const skip = translate('components.newWorkspace.directSetup.skip', 'Skip setup')
  return {
    kinds: {
      setup: {
        configLabel: translate('components.newWorkspace.directSetup.setupScript', 'Setup script'),
        askLabel: translate('components.newWorkspace.directSetup.askRunSetup', 'Run setup now?'),
        runLabel: run,
        runButtonLabel: run,
        skipButtonLabel: skip
      },
      'default-tabs': {
        configLabel: translate(
          'components.newWorkspace.directSetup.defaultTabCommands',
          'Default tab commands'
        ),
        askLabel: translate(
          'components.newWorkspace.directSetup.askRunDefaultTabs',
          'Run default tab commands now?'
        ),
        runLabel: run,
        runButtonLabel: run,
        skipButtonLabel: skip
      },
      'setup-and-default-tabs': {
        configLabel: translate(
          'components.newWorkspace.directSetup.setupAndDefaultTabs',
          'Setup and default tab commands'
        ),
        askLabel: translate(
          'components.newWorkspace.directSetup.askRunSetupAndDefaultTabs',
          'Run setup and default tab commands now?'
        ),
        runLabel: run,
        runButtonLabel: run,
        skipButtonLabel: skip
      }
    },
    sources: {
      yaml: translate('components.newWorkspace.directSetup.yamlSource', 'orca.yaml'),
      both: translate('components.newWorkspace.directSetup.bothSources', 'orca.yaml + local'),
      local: translate('components.newWorkspace.directSetup.localSource', 'local settings')
    },
    help: translate(
      'components.newWorkspace.directSetup.description',
      'Choose whether to run setup before creating this workspace.'
    ),
    checking: translate(
      'components.newWorkspace.directSetup.description',
      'Choose whether to run setup before creating this workspace.'
    )
  }
}
