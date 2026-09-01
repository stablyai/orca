import { useEffect, useMemo, useState } from 'react'
import type {
  BuiltInTuiAgent,
  CustomTuiAgentId,
  GlobalSettings,
  TuiAgent
} from '../../../../shared/types'
import { getAgentCatalog, getAgentLabel } from '@/lib/agent-catalog'
import { translate } from '@/i18n/i18n'
import { useLocalAgentCatalog } from '@/hooks/useLocalAgentCatalog'
import { useDetectedAgents, type AgentDetectionTarget } from '@/hooks/useDetectedAgents'
import { setDefaultTuiAgent, setTuiAgentEnabled } from '@/lib/agent-catalog-authoring'
import {
  AgentCatalogSectionView,
  type DeleteCustomTarget,
  type RepairDuplicateTarget,
  type RepairEditTarget,
  type RepairReplaceTarget,
  type ReviewReferencesTarget
} from './AgentCatalogSectionView'
import {
  AgentCatalogMigrationBlockedNotice,
  asAgentCatalogMigrationBlocked
} from './agent-catalog-migration-blocked'
import {
  AgentAuthoringWriteFailureNotice,
  asAgentAuthoringWriteFailure
} from './agent-authoring-write-failure'
import {
  AgentCatalogSchemaTooNewNotice,
  asAgentCatalogSchemaTooNew
} from './agent-catalog-schema-too-new'
import { DataRecoverySettingsRow } from '../data-recovery/DataRecoverySettingsRow'
import { CustomAgentEditorDialog } from './CustomAgentEditorDialog'
import { BuiltInLaunchSettingsDialog } from './BuiltInLaunchSettingsDialog'
import { CustomAgentDeleteDialog } from './CustomAgentDeleteDialog'
import { CustomAgentReferenceDialog } from './CustomAgentReferenceDialog'
import { CustomAgentDisableDialog } from './CustomAgentDisableDialog'
import { CustomAgentRepairDialog } from './CustomAgentRepairDialog'
import { CustomAgentDuplicateRepairDialog } from './CustomAgentDuplicateRepairDialog'
import { BuiltInDisableDialog } from './BuiltInDisableDialog'
import type { AgentSessionSourceHomeControl } from './codex-session-source-home-control'
import {
  recommendDeleteDefault,
  type DeleteDefaultRecommendation
} from './custom-agent-delete-plan'
import { disableNeedsConfirmation } from './custom-agent-disable-plan'
import { baseDisableNeedsConfirmation, countEnabledDerivatives } from './base-disable-plan'
import { isCustomTuiAgentId } from '../../../../shared/custom-tui-agent-identity'
import type {
  AgentReferenceSummary,
  BaseDisableImpact
} from '../../../../shared/agent-reference-snapshot'
import type { AgentCatalogSchemaTooNew } from '../../../../shared/data-recovery'
import type { CustomAgentEditorMode } from './custom-agent-editor-state'
import type { DefaultAgentSelection } from './AgentDefaultCombobox'

export type AgentCatalogSectionProps = {
  agentCmdOverrides: GlobalSettings['agentCmdOverrides']
  /** Codex session-history source home, prebuilt by the pane (it owns global
   *  settings + updateSettings); forwarded to the codex launch-settings dialog. */
  codexSessionSourceHome?: AgentSessionSourceHomeControl
  detectionTarget?: AgentDetectionTarget
  /** Paired web is view-only; the pane's disabled fieldset also blocks interaction. */
  readOnly?: boolean
}

/**
 * Connected owner of the Settings agent catalog: it holds the single local
 * snapshot fetch and detection subscription and passes the resolved snapshot to
 * the presentational view, so the view stays unit-testable with a synchronous
 * production snapshot. Custom-agent create/edit/duplicate refetch explicitly
 * because those change `customAgents`, which the settings-slice subscription in
 * `useLocalAgentCatalog` does not observe.
 */
export function AgentCatalogSection({
  agentCmdOverrides,
  codexSessionSourceHome,
  detectionTarget,
  readOnly
}: AgentCatalogSectionProps): React.JSX.Element {
  const { snapshot, unavailable, refetch } = useLocalAgentCatalog()
  const { detectedIds, isRefreshing, refresh } = useDetectedAgents(detectionTarget)
  const detectedSet = useMemo<ReadonlySet<string> | null>(
    () => (detectedIds ? new Set(detectedIds) : null),
    [detectedIds]
  )

  // Why: while the pre-v1 backup is failing the host rejects every catalog
  // write; without surfacing that, the toggles/default picker look like silent
  // no-ops. A later success clears the notice (the block lifted).
  const [migrationBlockedError, setMigrationBlockedError] = useState<string | null>(null)
  // Why: the block is a load-time state (failed pre-v1 backup), not just a
  // mutation outcome — a user who never edits must still learn writes are
  // fail-closed. Each real snapshot is authoritative both ways: it arms the
  // notice and clears one left stale by an app-banner Retry.
  useEffect(() => {
    if (!snapshot) {
      return
    }
    setMigrationBlockedError(
      typeof snapshot.migrationBlockedError === 'string' ? snapshot.migrationBlockedError : null
    )
  }, [snapshot])
  // Why: toggles and the default picker have no dialog to report into, so a
  // durable-write rejection would otherwise look like a silent no-op that saved.
  const [writeFailed, setWriteFailed] = useState(false)
  // Why: a newer build's schema stamp makes authoring read-only with nothing to
  // retry; the snapshot arms it at load, and a rejected mutation arms it too when
  // the profile went read-only after this snapshot was taken.
  const [schemaTooNew, setSchemaTooNew] = useState<AgentCatalogSchemaTooNew | null>(null)
  useEffect(() => {
    if (!snapshot) {
      return
    }
    setSchemaTooNew(snapshot.schemaTooNew ?? null)
  }, [snapshot])
  const surfaceMutationOutcome = (result: { ok: boolean }): void => {
    const blocked = asAgentCatalogMigrationBlocked(result)
    if (blocked) {
      setMigrationBlockedError(blocked.migrationError)
    } else if (result.ok) {
      setMigrationBlockedError(null)
    }
    const tooNew = asAgentCatalogSchemaTooNew(result)
    if (tooNew) {
      setSchemaTooNew({
        persistedVersion: tooNew.persistedVersion,
        supportedVersion: tooNew.supportedVersion
      })
    }
    setWriteFailed(asAgentAuthoringWriteFailure(result) !== null)
  }

  const [editorOpen, setEditorOpen] = useState(false)
  const [editorMode, setEditorMode] = useState<CustomAgentEditorMode>({ kind: 'new' })
  const openEditor = (mode: CustomAgentEditorMode): void => {
    if (readOnly) {
      return
    }
    setEditorMode(mode)
    setEditorOpen(true)
  }

  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<{
    agent: DeleteCustomTarget
    recommendation: DeleteDefaultRecommendation
  } | null>(null)
  const handleDeleteCustom = (agent: DeleteCustomTarget): void => {
    if (readOnly) {
      return
    }
    const recommendation = recommendDeleteDefault({
      base: agent.baseAgent,
      detectedIds: detectedSet,
      agentCmdOverrides,
      disabledAgents: new Set(snapshot?.disabledAgents ?? [])
    })
    setDeleteTarget({ agent, recommendation })
    setDeleteOpen(true)
  }

  const [referenceOpen, setReferenceOpen] = useState(false)
  const [referenceTarget, setReferenceTarget] = useState<{
    agent: ReviewReferencesTarget
    deleted: boolean
  } | null>(null)
  const handleReviewReferences = (agent: ReviewReferencesTarget, deleted: boolean): void => {
    setReferenceTarget({ agent, deleted })
    setReferenceOpen(true)
  }

  const [repairReplaceOpen, setRepairReplaceOpen] = useState(false)
  const [repairReplaceTarget, setRepairReplaceTarget] = useState<RepairReplaceTarget | null>(null)
  const handleRepairEdit = (target: RepairEditTarget): void => {
    openEditor({
      kind: 'repair-edit',
      id: target.id,
      repairToken: target.repairToken,
      baseAgent: target.baseAgent
    })
  }
  const handleRepairReplace = (target: RepairReplaceTarget): void => {
    if (readOnly) {
      return
    }
    setRepairReplaceTarget(target)
    setRepairReplaceOpen(true)
  }
  // "Replace as new agent" hands off to the editor in repair-replace mode, which
  // mints a fresh id through repair-corrupt/replace when the user saves.
  const startRepairReplaceEditor = (repairToken: string): void => {
    setRepairReplaceOpen(false)
    openEditor({ kind: 'repair-replace', repairToken })
  }

  const [duplicateRepairOpen, setDuplicateRepairOpen] = useState(false)
  const [duplicateRepairTarget, setDuplicateRepairTarget] = useState<RepairDuplicateTarget | null>(
    null
  )
  const handleRepairDuplicate = (target: RepairDuplicateTarget): void => {
    if (readOnly) {
      return
    }
    setDuplicateRepairTarget(target)
    setDuplicateRepairOpen(true)
  }

  const handleSelectDefault = (selection: DefaultAgentSelection): void => {
    if (readOnly) {
      return
    }
    void setDefaultTuiAgent(selection).then(surfaceMutationOutcome)
  }
  const [disableOpen, setDisableOpen] = useState(false)
  const [disableTarget, setDisableTarget] = useState<{
    id: CustomTuiAgentId
    label: string
    summary: AgentReferenceSummary[]
    revision: number
  } | null>(null)

  // Disabling a custom is immediate only when it is provably unreferenced;
  // otherwise the reference-aware confirmation opens (plan §973). Base-disable
  // impact counts are a pending host query, so bases still toggle directly.
  const requestCustomDisable = async (id: CustomTuiAgentId): Promise<void> => {
    // A failed query cannot prove "unreferenced": report an unreadable owner
    // (count -1) so the confirmation still opens instead of being bypassed.
    const summary = await window.api.settings.agentCatalog
      .referenceSummary({ id })
      .catch((): AgentReferenceSummary[] => [{ owner: 'default', count: -1 }])
    if (!disableNeedsConfirmation(summary)) {
      void setTuiAgentEnabled(id, false).then(surfaceMutationOutcome)
      return
    }
    const ready = snapshot?.customAgents.find(
      (agent) => agent.status === 'ready' && agent.definition.id === id
    )
    const label = ready?.status === 'ready' ? ready.definition.label : id
    setDisableTarget({ id, label, summary, revision: snapshot?.revision ?? 0 })
    setDisableOpen(true)
  }

  const [baseDisableOpen, setBaseDisableOpen] = useState(false)
  const [baseDisableTarget, setBaseDisableTarget] = useState<{
    base: BuiltInTuiAgent
    baseLabel: string
    enabledDerivatives: number
    impact: BaseDisableImpact
    revision: number
  } | null>(null)

  // Disabling a base is immediate only when nothing it affects exists; otherwise
  // the confirmation names enabled derivatives, saved references, and resumable
  // sessions (plan §973). Derivatives are local; references/sessions are host-computed.
  const requestBaseDisable = async (base: BuiltInTuiAgent): Promise<void> => {
    // A failed query cannot prove "no impact": `atLeast` marks the counts as
    // floors so the confirmation still opens instead of being bypassed.
    const impact = await window.api.settings.agentCatalog
      .baseDisableImpact({ base })
      .catch<BaseDisableImpact>(() => ({
        savedReferences: { count: 0, atLeast: true },
        resumableSessions: { count: 0, atLeast: true }
      }))
    const enabledDerivatives = snapshot ? countEnabledDerivatives(snapshot, base) : 0
    if (!baseDisableNeedsConfirmation({ enabledDerivatives, impact })) {
      void setTuiAgentEnabled(base, false).then(surfaceMutationOutcome)
      return
    }
    setBaseDisableTarget({
      base,
      baseLabel: getAgentLabel(base),
      enabledDerivatives,
      impact,
      revision: snapshot?.revision ?? 0
    })
    setBaseDisableOpen(true)
  }

  const handleToggleEnabled = (agent: TuiAgent, enabled: boolean): void => {
    if (readOnly) {
      return
    }
    if (!enabled) {
      if (isCustomTuiAgentId(agent)) {
        void requestCustomDisable(agent)
      } else {
        void requestBaseDisable(agent)
      }
      return
    }
    void setTuiAgentEnabled(agent, enabled).then(surfaceMutationOutcome)
  }
  const handleRefresh = (): void => {
    if (readOnly) {
      return
    }
    void refresh()
  }

  if (unavailable) {
    // Paired web: the local catalog surface doesn't exist here; the pane-level
    // read-only notice explains where to manage agents.
    return (
      <p className="text-sm text-muted-foreground">
        {translate(
          'auto.components.settings.AgentCatalogSection.unavailable',
          'Custom agents are managed on the desktop host.'
        )}
      </p>
    )
  }

  if (!snapshot) {
    return (
      <p className="text-sm text-muted-foreground">
        {translate('auto.components.settings.AgentCatalogSection.loading', 'Loading agents…')}
      </p>
    )
  }

  return (
    <>
      {migrationBlockedError !== null ? (
        <AgentCatalogMigrationBlockedNotice migrationError={migrationBlockedError} />
      ) : null}
      {schemaTooNew ? <AgentCatalogSchemaTooNewNotice state={schemaTooNew} /> : null}
      {writeFailed ? <AgentAuthoringWriteFailureNotice /> : null}
      <AgentCatalogSectionView
        snapshot={snapshot}
        detectedIds={detectedSet}
        agentCmdOverrides={agentCmdOverrides}
        readOnly={readOnly}
        isRefreshing={isRefreshing}
        onSelectDefault={handleSelectDefault}
        onToggleEnabled={handleToggleEnabled}
        onEditCustom={(id: CustomTuiAgentId) => openEditor({ kind: 'edit', id })}
        onEditBuiltIn={(agent: BuiltInTuiAgent) => openEditor({ kind: 'built-in-launch', agent })}
        onDeleteCustom={handleDeleteCustom}
        onReviewReferences={(target) => handleReviewReferences(target, true)}
        onDuplicate={(sourceAgent: TuiAgent) => openEditor({ kind: 'duplicate', sourceAgent })}
        onNewAgent={() => openEditor({ kind: 'new' })}
        onRefresh={handleRefresh}
        onRepairEdit={handleRepairEdit}
        onRepairReplace={handleRepairReplace}
        onRepairDuplicate={handleRepairDuplicate}
      />
      {!readOnly ? <DataRecoverySettingsRow /> : null}
      {editorMode.kind === 'built-in-launch' ? (
        <BuiltInLaunchSettingsDialog
          open={editorOpen}
          agent={editorMode.agent}
          codexSessionSourceHome={codexSessionSourceHome}
          onOpenChange={setEditorOpen}
          onSaved={() => refetch()}
        />
      ) : (
        <CustomAgentEditorDialog
          open={editorOpen}
          mode={editorMode}
          baseAgentOptions={getAgentCatalog()}
          onOpenChange={setEditorOpen}
          onSaved={() => refetch()}
        />
      )}
      {deleteTarget ? (
        <CustomAgentDeleteDialog
          open={deleteOpen}
          agent={deleteTarget.agent}
          recommendation={deleteTarget.recommendation}
          onOpenChange={setDeleteOpen}
          onDeleted={() => refetch()}
          onReviewReferences={() => handleReviewReferences(deleteTarget.agent, false)}
        />
      ) : null}
      {referenceTarget ? (
        <CustomAgentReferenceDialog
          open={referenceOpen}
          agent={referenceTarget.agent}
          deleted={referenceTarget.deleted}
          onOpenChange={setReferenceOpen}
        />
      ) : null}
      {disableTarget ? (
        <CustomAgentDisableDialog
          open={disableOpen}
          agent={{ id: disableTarget.id, label: disableTarget.label }}
          initialSummary={disableTarget.summary}
          initialRevision={disableTarget.revision}
          onOpenChange={setDisableOpen}
          onDisabled={() => refetch()}
        />
      ) : null}
      {baseDisableTarget ? (
        <BuiltInDisableDialog
          open={baseDisableOpen}
          base={baseDisableTarget.base}
          baseLabel={baseDisableTarget.baseLabel}
          initialEnabledDerivatives={baseDisableTarget.enabledDerivatives}
          initialImpact={baseDisableTarget.impact}
          initialRevision={baseDisableTarget.revision}
          onOpenChange={setBaseDisableOpen}
          onDisabled={() => refetch()}
        />
      ) : null}
      {repairReplaceTarget ? (
        <CustomAgentRepairDialog
          open={repairReplaceOpen}
          target={repairReplaceTarget}
          onOpenChange={setRepairReplaceOpen}
          onReplaceAsNew={() => startRepairReplaceEditor(repairReplaceTarget.repairToken)}
          onDiscarded={() => refetch()}
        />
      ) : null}
      {duplicateRepairTarget ? (
        <CustomAgentDuplicateRepairDialog
          open={duplicateRepairOpen}
          duplicateId={duplicateRepairTarget.duplicateId}
          rows={duplicateRepairTarget.rows}
          onOpenChange={setDuplicateRepairOpen}
          onResolved={() => refetch()}
        />
      ) : null}
    </>
  )
}
