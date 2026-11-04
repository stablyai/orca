import type { SetupConfig } from '../../../../shared/orca-hook-setup-config'

export type WorkspaceSetupKindCopy = {
  configLabel: string
  runLabel: string
  askLabel: string
  runButtonLabel: string
  skipButtonLabel: string
}

export type WorkspaceSetupLabels = {
  kinds: Record<SetupConfig['kind'], WorkspaceSetupKindCopy>
  sources: Record<SetupConfig['source'], string>
  help: string
  checking: string
}

export function selectWorkspaceSetupCopy(config: SetupConfig | null, labels: WorkspaceSetupLabels) {
  return {
    ...labels.kinds[config?.kind ?? 'setup'],
    sourceLabel: config ? labels.sources[config.source] : '',
    help: labels.help,
    checking: labels.checking
  }
}

export type WorkspaceSetupCopy = ReturnType<typeof selectWorkspaceSetupCopy>
