import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { WorkspaceSetupLabels } from './workspace-setup-section-model'

export function getComposerWorkspaceSetupLabels(t: Translate = translate): WorkspaceSetupLabels {
  return {
    kinds: {
      setup: {
        configLabel: t(
          'auto.components.NewWorkspaceComposerCard.setupConfigSetupScript',
          'Setup script'
        ),
        runLabel: t(
          'auto.components.NewWorkspaceComposerCard.runSetupCommand',
          'Run setup command'
        ),
        askLabel: t('auto.components.NewWorkspaceComposerCard.askRunSetup', 'Run setup now?'),
        runButtonLabel: t('auto.components.NewWorkspaceComposerCard.runSetupNow', 'Run setup now'),
        skipButtonLabel: t('auto.components.NewWorkspaceComposerCard.skipForNow', 'Skip for now')
      },
      'default-tabs': {
        configLabel: t(
          'auto.components.NewWorkspaceComposerCard.setupConfigDefaultTabs',
          'Default tab commands'
        ),
        runLabel: t(
          'auto.components.NewWorkspaceComposerCard.runDefaultTabCommands',
          'Run default tab commands'
        ),
        askLabel: t(
          'auto.components.NewWorkspaceComposerCard.askRunDefaultTabCommands',
          'Run default tab commands now?'
        ),
        runButtonLabel: t(
          'auto.components.NewWorkspaceComposerCard.runCommandsNow',
          'Run commands now'
        ),
        skipButtonLabel: t('auto.components.NewWorkspaceComposerCard.skipCommands', 'Skip commands')
      },
      'setup-and-default-tabs': {
        configLabel: t(
          'auto.components.NewWorkspaceComposerCard.setupConfigSetupAndDefaultTabs',
          'Setup and default tab commands'
        ),
        runLabel: t(
          'auto.components.NewWorkspaceComposerCard.runSetupAndDefaultTabCommands',
          'Run setup and default tab commands'
        ),
        askLabel: t(
          'auto.components.NewWorkspaceComposerCard.askRunSetupAndDefaultTabCommands',
          'Run setup and default tab commands now?'
        ),
        runButtonLabel: t(
          'auto.components.NewWorkspaceComposerCard.runCommandsNow',
          'Run commands now'
        ),
        skipButtonLabel: t('auto.components.NewWorkspaceComposerCard.skipCommands', 'Skip commands')
      }
    },
    sources: {
      yaml: t('auto.components.NewWorkspaceComposerCard.23bb365554', 'orca.yaml'),
      both: t('auto.components.NewWorkspaceComposerCard.326a578923', 'orca.yaml + local'),
      local: t('auto.components.NewWorkspaceComposerCard.92e34f0311', 'local settings')
    },
    help: t(
      'auto.components.NewWorkspaceComposerCard.9a70e4859e',
      'Choose whether to run setup before creating this workspace.'
    ),
    checking: t(
      'auto.components.NewWorkspaceComposerCard.803b7fe72f',
      'Checking setup configuration...'
    )
  }
}

export function getComposerSetupStartupLabel(t: Translate = translate): string {
  return t(
    'auto.components.NewWorkspaceComposerCard.waitForSetupBeforeAgent',
    'Wait for setup to complete before starting agent'
  )
}
