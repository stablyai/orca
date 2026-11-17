import { useAppStore } from '@/store'
import { getRuntimeEnvironmentRevision } from '@/runtime/rpc/environment-revisions/runtime-environment-revision'
import type { PendingAutomationRunNavigation } from '@/store/slices/ui/ui-slice-contract-core'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { AutomationsPageLocalState } from './use-automations-page-local-state'
import type { AutomationListRow } from './listing/automation-list-row-identity'
import type { AutomationCapturedOwner } from './hosts/automation-captured-owner'
import {
  hostStableKey,
  ownerKey
} from '../../../../shared/automations/ownership/automation-owner-key'
import {
  getAutomationAuthorityTarget,
  getAutomationHostTargetKey
} from './hosts/automation-host-client'
import {
  isRuntimeHostContactRevoked,
  lastVerifiedRuntimeStatus
} from '../../../../shared/remote-runtime/host-status/runtime-host-status'

export function automationNavigationGuardCurrent(
  expected: NonNullable<PendingAutomationRunNavigation['expectedDefinition']>
): boolean {
  const authority = expected.owner.authority
  const entry =
    authority.kind === 'runtime'
      ? useAppStore.getState().runtimeStatusByEnvironmentId.get(authority.environmentId)
      : undefined
  return (
    authority.kind === 'desktop' ||
    (!isRuntimeHostContactRevoked(entry) &&
      getRuntimeEnvironmentRevision(authority.environmentId) === authority.pairingRevision &&
      lastVerifiedRuntimeStatus(entry)?.runtimeId === expected.runtimeId)
  )
}

export function rejectAutomationNavigation(
  local: Pick<
    AutomationsPageLocalState,
    'setSelectedAutomationRunPageId' | 'setIsDetailOpen' | 'setPageView'
  >
): void {
  useAppStore.getState().setPendingAutomationRunNavigation(null)
  local.setSelectedAutomationRunPageId(null)
  local.setIsDetailOpen(false)
  local.setPageView('automations')
  toast.message(
    translate(
      'components.native-chat.automationSaved.navigationChanged',
      'This automation’s host or identity changed. Open it from the Automations list.'
    )
  )
}

export function automationNavigationRowEligibility(
  pending: PendingAutomationRunNavigation,
  row: AutomationListRow,
  owners: ReadonlyMap<string, AutomationCapturedOwner>,
  answered: boolean
): 'ready' | 'waiting' | 'changed' {
  const expected = pending.expectedDefinition
  if (!expected) {
    return 'ready'
  }
  const owner = owners.get(row.key)?.owner
  if (!owner) {
    return answered ? 'changed' : 'waiting'
  }
  return ownerKey(owner) === ownerKey(expected.owner) &&
    row.automation.createdAt === expected.createdAt
    ? 'ready'
    : 'changed'
}

export function automationNavigationRowMatches(
  pending: PendingAutomationRunNavigation,
  row: AutomationListRow,
  targetKey: string
): boolean {
  if (row.automation.id !== pending.automationId) {
    return false
  }
  if (
    pending.expectedDefinition &&
    (!row.catalogRef ||
      hostStableKey(row.catalogRef) !== hostStableKey(pending.expectedDefinition.owner))
  ) {
    return false
  }
  return (
    !row.catalogRef ||
    getAutomationHostTargetKey(getAutomationAuthorityTarget(row.catalogRef.authority)) === targetKey
  )
}
