import { translate } from '@/i18n/i18n'
import type { SetupConfig } from '../../../../shared/orca-hook-setup-config'

export type SetupDecisionLabels = {
  setupConfigLabel: string
  setupRunLabel: string
  setupAskLabel: string
  setupRunButtonLabel: string
  setupSkipButtonLabel: string
}

/** Copy for the setup decision row, keyed on what the repo's setup config actually runs. */
export function getSetupDecisionLabels(setupConfig: SetupConfig | null): SetupDecisionLabels {
  const kind = setupConfig?.kind
  const isSetupOnly = kind === 'setup'
  return {
    setupConfigLabel:
      kind === 'default-tabs'
        ? translate(
            'auto.components.NewWorkspaceComposerCard.setupConfigDefaultTabs',
            'Default tab commands'
          )
        : kind === 'setup-and-default-tabs'
          ? translate(
              'auto.components.NewWorkspaceComposerCard.setupConfigSetupAndDefaultTabs',
              'Setup and default tab commands'
            )
          : translate(
              'auto.components.NewWorkspaceComposerCard.setupConfigSetupScript',
              'Setup script'
            ),
    setupRunLabel:
      kind === 'default-tabs'
        ? translate(
            'auto.components.NewWorkspaceComposerCard.runDefaultTabCommands',
            'Run default tab commands'
          )
        : kind === 'setup-and-default-tabs'
          ? translate(
              'auto.components.NewWorkspaceComposerCard.runSetupAndDefaultTabCommands',
              'Run setup and default tab commands'
            )
          : translate(
              'auto.components.NewWorkspaceComposerCard.runSetupCommand',
              'Run setup command'
            ),
    setupAskLabel:
      kind === 'default-tabs'
        ? translate(
            'auto.components.NewWorkspaceComposerCard.askRunDefaultTabCommands',
            'Run default tab commands now?'
          )
        : kind === 'setup-and-default-tabs'
          ? translate(
              'auto.components.NewWorkspaceComposerCard.askRunSetupAndDefaultTabCommands',
              'Run setup and default tab commands now?'
            )
          : translate('auto.components.NewWorkspaceComposerCard.askRunSetup', 'Run setup now?'),
    setupRunButtonLabel: isSetupOnly
      ? translate('auto.components.NewWorkspaceComposerCard.runSetupNow', 'Run setup now')
      : translate('auto.components.NewWorkspaceComposerCard.runCommandsNow', 'Run commands now'),
    setupSkipButtonLabel: isSetupOnly
      ? translate('auto.components.NewWorkspaceComposerCard.skipForNow', 'Skip for now')
      : translate('auto.components.NewWorkspaceComposerCard.skipCommands', 'Skip commands')
  }
}
