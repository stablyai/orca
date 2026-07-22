import { DEFAULT_WORKSPACE_STATUSES } from '../../../../shared/workspace-status-defaults'
import type { WorkspaceStatusDefinition } from '../../../../shared/types'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { translate } from '@/i18n/i18n'

const DEFAULT_LABEL_BY_STATUS_ID = new Map<string, string>(
  DEFAULT_WORKSPACE_STATUSES.map((status) => [status.id, status.label])
)

const getLocalizedDefaultStatusLabels = createLocalizedCatalog(
  (): ReadonlyMap<string, string> =>
    new Map<string, string>(
      DEFAULT_WORKSPACE_STATUSES.map((status) => [
        status.id,
        translate(`workspaceStatus.${status.id}.label`, status.label)
      ])
    )
)

// Why: users can rename/reorder statuses that keep a default id, so only translate
// labels still matching the shipped default text — a customized label must survive untouched.
export function getLocalizedWorkspaceStatusLabel(status: WorkspaceStatusDefinition): string {
  if (DEFAULT_LABEL_BY_STATUS_ID.get(status.id) !== status.label) {
    return status.label
  }
  return getLocalizedDefaultStatusLabels().get(status.id) ?? status.label
}
