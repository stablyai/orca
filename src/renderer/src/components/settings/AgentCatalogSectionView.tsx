import { useMemo } from 'react'
import { AlertTriangle } from 'lucide-react'
import type {
  BuiltInTuiAgent,
  CustomTuiAgentId,
  GlobalSettings,
  TuiAgent
} from '../../../../shared/types'
import type { LocalAgentCatalogSnapshot } from '../../../../shared/agent-catalog-snapshot'
import { translate } from '@/i18n/i18n'
import { SettingsSubsectionHeader } from './SettingsFormControls'
import { getSettingOwnershipSummary } from './setting-ownership'
import { AgentDefaultCombobox, type DefaultAgentSelection } from './AgentDefaultCombobox'
import { AgentCatalogManager } from './AgentCatalogManager'
import { deriveAgentCatalogRows, type AgentCatalogRow } from './agent-catalog-rows'
import type { AgentCatalogRowCallbacks } from './AgentCatalogRowView'
import type { DuplicateRepairRow } from './custom-agent-duplicate-repair-plan'
import {
  deriveAgentDefaultOptions,
  deriveDefaultComboboxValue,
  deriveStaleDefault,
  isDefaultUnset
} from './agent-default-options'

export type AgentCatalogSectionViewProps = {
  /** The resolved production snapshot; the connected section owns the fetch. */
  snapshot: LocalAgentCatalogSnapshot
  detectedIds: ReadonlySet<string> | null
  agentCmdOverrides: GlobalSettings['agentCmdOverrides']
  readOnly?: boolean
  isRefreshing?: boolean
  onSelectDefault: (selection: DefaultAgentSelection) => void
  onToggleEnabled: (agent: TuiAgent, enabled: boolean) => void
  onEditCustom: (id: CustomTuiAgentId) => void
  onEditBuiltIn: (agent: BuiltInTuiAgent) => void
  onDeleteCustom: (agent: DeleteCustomTarget) => void
  onReviewReferences: (target: ReviewReferencesTarget) => void
  onDuplicate: (sourceAgent: TuiAgent) => void
  onNewAgent: () => void
  onRefresh: () => void
  // Repair routing (plan §972): a canonical id/base row edits in place; a
  // malformed row discards or replaces as new; a duplicate-id group resolves
  // atomically. The view derives the route and hands the parent a typed target.
  onRepairEdit: (target: RepairEditTarget) => void
  onRepairReplace: (target: RepairReplaceTarget) => void
  onRepairDuplicate: (target: RepairDuplicateTarget) => void
}

export type DeleteCustomTarget = {
  id: CustomTuiAgentId
  label: string
  baseAgent: BuiltInTuiAgent
  isDefault: boolean
}

export type ReviewReferencesTarget = {
  id: CustomTuiAgentId
  label: string
  baseAgent: BuiltInTuiAgent
}

export type RepairEditTarget = {
  id: CustomTuiAgentId
  repairToken: string
  baseAgent: BuiltInTuiAgent
}

export type RepairReplaceTarget = { repairToken: string; label: string | null }

export type RepairDuplicateTarget = {
  duplicateId: CustomTuiAgentId
  rows: DuplicateRepairRow[]
}

// All rows sharing the corrupt id: the atomic resolve-duplicate-id mutation must
// cover the whole group, so the view collects it from the derived rows.
function gatherDuplicateGroup(
  rows: readonly AgentCatalogRow[],
  duplicateId: CustomTuiAgentId
): DuplicateRepairRow[] {
  const group: DuplicateRepairRow[] = []
  for (const row of rows) {
    if (
      row.kind === 'repair' &&
      row.route === 'duplicate' &&
      row.id === duplicateId &&
      row.baseAgent
    ) {
      group.push({
        repairToken: row.repairToken,
        label: row.label,
        baseAgent: row.baseAgent,
        draftAvailability: row.draftAvailability
      })
    }
  }
  return group
}

export function AgentCatalogSectionView({
  snapshot,
  detectedIds,
  agentCmdOverrides,
  readOnly,
  isRefreshing,
  onSelectDefault,
  onToggleEnabled,
  onEditCustom,
  onEditBuiltIn,
  onDeleteCustom,
  onReviewReferences,
  onDuplicate,
  onNewAgent,
  onRefresh,
  onRepairEdit,
  onRepairReplace,
  onRepairDuplicate
}: AgentCatalogSectionViewProps): React.JSX.Element {
  const rows = useMemo(
    () => deriveAgentCatalogRows({ snapshot, settings: { agentCmdOverrides }, detectedIds }),
    [snapshot, agentCmdOverrides, detectedIds]
  )
  const defaultOptions = useMemo(() => deriveAgentDefaultOptions(snapshot), [snapshot])
  const defaultValue = deriveDefaultComboboxValue(snapshot)
  const staleDefault = deriveStaleDefault(snapshot)
  const defaultUnset = isDefaultUnset(snapshot)

  // Only configured rows carry an id/switch; repair and tombstone rows never
  // reach these handlers because they render no switch or Edit/Duplicate menu.
  const rowCallbacks: AgentCatalogRowCallbacks = {
    onToggleEnabled: (row, enabled) => {
      if (row.kind === 'built-in' || row.kind === 'custom') {
        onToggleEnabled(row.id, enabled)
      }
    },
    onEdit: (row) => {
      if (row.kind === 'custom') {
        onEditCustom(row.id)
      } else if (row.kind === 'built-in') {
        onEditBuiltIn(row.id)
      }
    },
    onDuplicate: (row) => {
      if (row.kind === 'built-in' || row.kind === 'custom') {
        onDuplicate(row.id)
      }
    },
    onDelete: (row) => {
      if (row.kind === 'custom') {
        onDeleteCustom({
          id: row.id,
          label: row.label,
          baseAgent: row.baseAgent,
          isDefault: row.isDefault
        })
      }
    },
    onRepair: (row) => {
      if (row.kind !== 'repair') {
        return
      }
      if (row.route === 'edit' && row.id && row.baseAgent) {
        onRepairEdit({ id: row.id, repairToken: row.repairToken, baseAgent: row.baseAgent })
      } else if (row.route === 'duplicate' && row.id) {
        onRepairDuplicate({ duplicateId: row.id, rows: gatherDuplicateGroup(rows, row.id) })
      } else {
        onRepairReplace({ repairToken: row.repairToken, label: row.label })
      }
    },
    onReviewReferences: (row) => {
      if (row.kind === 'deleted') {
        onReviewReferences({ id: row.id, label: row.label, baseAgent: row.baseAgent })
      }
    }
  }

  return (
    // Why: gap (not space-y) — the default fieldset uses m-0, and Tailwind v4's
    // space-y margins are :where() (zero specificity) so m-0 would collapse the
    // gap between Default agent and Agents.
    <div className="flex flex-col gap-8">
      {/* Why: read-only disabling is scoped per control group (not one pane-wide
          fieldset) so the catalog search box stays usable on paired clients. */}
      <fieldset disabled={readOnly} className="m-0 min-w-0 border-0 p-0">
        <section className="space-y-3">
          <SettingsSubsectionHeader
            title={translate(
              'auto.components.settings.AgentCatalogSection.defaultTitle',
              'Default agent'
            )}
            description={getSettingOwnershipSummary('agentLaunchDefaults').description}
          />
          {defaultUnset ? <DefaultAttentionBanner /> : null}
          <AgentDefaultCombobox
            value={defaultValue}
            options={defaultOptions}
            staleDefault={staleDefault}
            unset={defaultUnset}
            autoFocusTrigger={defaultUnset}
            onChange={onSelectDefault}
          />
        </section>
      </fieldset>

      <AgentCatalogManager
        rows={rows}
        readOnly={readOnly}
        isRefreshing={isRefreshing}
        onNewAgent={onNewAgent}
        onRefresh={onRefresh}
        {...rowCallbacks}
      />
    </div>
  )
}

function DefaultAttentionBanner(): React.JSX.Element {
  return (
    <div
      role="status"
      className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-400"
    >
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
      <span>
        {translate(
          'auto.components.settings.AgentCatalogSection.nullDefaultAttention',
          "Choose a default agent. Until you do, attended launches can't start and will ask you to pick one."
        )}
      </span>
    </div>
  )
}
