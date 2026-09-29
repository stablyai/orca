import type { SetupConfig } from '@/lib/new-workspace'

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
        ? 'Default tab commands'
        : kind === 'setup-and-default-tabs'
          ? 'Setup and default tab commands'
          : 'Setup script',
    setupRunLabel:
      kind === 'default-tabs'
        ? 'Run default tab commands'
        : kind === 'setup-and-default-tabs'
          ? 'Run setup and default tab commands'
          : 'Run setup command',
    setupAskLabel:
      kind === 'default-tabs'
        ? 'Run default tab commands now?'
        : kind === 'setup-and-default-tabs'
          ? 'Run setup and default tab commands now?'
          : 'Run setup now?',
    setupRunButtonLabel: isSetupOnly ? 'Run setup now' : 'Run commands now',
    setupSkipButtonLabel: isSetupOnly ? 'Skip for now' : 'Skip commands'
  }
}
