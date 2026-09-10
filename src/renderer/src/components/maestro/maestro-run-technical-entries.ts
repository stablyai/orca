import type {
  MaestroRunProgress,
  MaestroRunProgressV2
} from '../../../../shared/maestro-run-progress'
import { translate } from '@/i18n/i18n'

type LegacyRunProgress = Extract<MaestroRunProgress, { available: true }>

function entry(label: 'run' | 'host' | 'workspace' | 'revision' | 'reference', value: string) {
  const fallback = {
    run: 'Run',
    host: 'Host',
    workspace: 'Workspace',
    revision: 'Revision',
    reference: 'Reference'
  }[label]
  return {
    label: translate(`auto.components.maestro.MaestroWorkspaceHarnessOverlay.${label}`, fallback),
    value
  }
}

export function maestroRunTechnicalEntries(params: {
  humanProgress: MaestroRunProgressV2 | null
  legacyProgress: LegacyRunProgress | null
  inspectedReference: string | null
}): { label: string; value: string }[] {
  const reference = params.inspectedReference ? [entry('reference', params.inspectedReference)] : []
  if (params.humanProgress) {
    return [
      entry('run', params.humanProgress.technical.run_id),
      entry('host', params.humanProgress.technical.execution_host_id),
      entry('workspace', params.humanProgress.technical.workspace_key),
      entry('revision', String(params.humanProgress.technical.revision)),
      ...reference
    ]
  }
  if (!params.legacyProgress) {
    return []
  }
  return [
    entry('run', params.legacyProgress.authority.runId),
    entry('host', params.legacyProgress.authority.workspace.executionHostId),
    entry('workspace', params.legacyProgress.authority.workspace.workspaceKey),
    entry('revision', String(params.legacyProgress.authority.revision)),
    ...reference
  ]
}
