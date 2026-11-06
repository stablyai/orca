import { translate } from '@/i18n/i18n'
import type { WorkspaceSetupLabels } from './workspace-setup-section-model'

export function getComposerWorkspaceSetupLabels(): WorkspaceSetupLabels {
  return {
    kinds: {
      setup: {
        configLabel: translate(
          'auto.components.NewWorkspaceComposerCard.setupConfigSetupScript',
          'Setup script'
        ),
        runLabel: translate(
          'auto.components.NewWorkspaceComposerCard.runSetupCommand',
          'Run setup command'
        ),
        askLabel: translate(
          'auto.components.NewWorkspaceComposerCard.askRunSetup',
          'Run setup now?'
        ),
        runButtonLabel: translate(
          'auto.components.NewWorkspaceComposerCard.runSetupNow',
          'Run setup now'
        ),
        skipButtonLabel: translate(
          'auto.components.NewWorkspaceComposerCard.skipForNow',
          'Skip for now'
        )
      },
      'default-tabs': {
        configLabel: translate(
          'auto.components.NewWorkspaceComposerCard.setupConfigDefaultTabs',
          'Default tab commands'
        ),
        runLabel: translate(
          'auto.components.NewWorkspaceComposerCard.runDefaultTabCommands',
          'Run default tab commands'
        ),
        askLabel: translate(
          'auto.components.NewWorkspaceComposerCard.askRunDefaultTabCommands',
          'Run default tab commands now?'
        ),
        runButtonLabel: translate(
          'auto.components.NewWorkspaceComposerCard.runCommandsNow',
          'Run commands now'
        ),
        skipButtonLabel: translate(
          'auto.components.NewWorkspaceComposerCard.skipCommands',
          'Skip commands'
        )
      },
      'setup-and-default-tabs': {
        configLabel: translate(
          'auto.components.NewWorkspaceComposerCard.setupConfigSetupAndDefaultTabs',
          'Setup and default tab commands'
        ),
        runLabel: translate(
          'auto.components.NewWorkspaceComposerCard.runSetupAndDefaultTabCommands',
          'Run setup and default tab commands'
        ),
        askLabel: translate(
          'auto.components.NewWorkspaceComposerCard.askRunSetupAndDefaultTabCommands',
          'Run setup and default tab commands now?'
        ),
        runButtonLabel: translate(
          'auto.components.NewWorkspaceComposerCard.runCommandsNow',
          'Run commands now'
        ),
        skipButtonLabel: translate(
          'auto.components.NewWorkspaceComposerCard.skipCommands',
          'Skip commands'
        )
      }
    },
    sources: {
      yaml: translate('auto.components.NewWorkspaceComposerCard.23bb365554', 'orca.yaml'),
      both: translate('auto.components.NewWorkspaceComposerCard.326a578923', 'orca.yaml + local'),
      local: translate('auto.components.NewWorkspaceComposerCard.92e34f0311', 'local settings')
    },
    help: translate(
      'auto.components.NewWorkspaceComposerCard.9a70e4859e',
      'Choose whether to run setup before creating this workspace.'
    ),
    checking: translate(
      'auto.components.NewWorkspaceComposerCard.803b7fe72f',
      'Checking setup configuration...'
    )
  }
}

export function getComposerSetupStartupLabel(): string {
  return translate(
    'auto.components.NewWorkspaceComposerCard.waitForSetupBeforeAgent',
    'Wait for setup to complete before starting agent'
  )
}
