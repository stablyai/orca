import { useSyncExternalStore } from 'react'
import { onRuntimeEnvironmentRevisionsPublished } from '@/runtime/rpc/environment-revisions/runtime-environment-revision'
import { useAppStore } from '@/store'
import type { PendingAutomationRunNavigation } from '@/store/slices/ui/ui-slice-contract-core'
import { automationOwnerForHostId, evaluateAutomationOwner } from './automation-host-owner'

export function automationNavigationContinuity(
  navigation: PendingAutomationRunNavigation
): 'same' | 'checking' | 'retired' | 'unpaired' {
  if (!navigation.owner) {
    return 'same'
  }
  const proof = evaluateAutomationOwner(navigation.owner)
  if (proof.status !== 'same' && proof.status !== 'continued') {
    return proof.status
  }
  const current = automationOwnerForHostId(navigation.hostId ?? 'local', useAppStore.getState())
  const target = current ? evaluateAutomationOwner(current) : null
  return target &&
    (target.status === 'same' || target.status === 'continued') &&
    JSON.stringify(target.owner) === JSON.stringify(proof.owner)
    ? 'same'
    : 'retired'
}

export function admitAutomationNavigation(navigation: PendingAutomationRunNavigation): boolean {
  const state = useAppStore.getState()
  if (navigation.owner && state.pendingAutomationRunNavigation !== navigation) {
    return false
  }
  const continuity = automationNavigationContinuity(navigation)
  if (continuity === 'same') {
    return true
  }
  if (continuity !== 'checking' && state.pendingAutomationRunNavigation === navigation) {
    state.setPendingAutomationRunNavigation(null)
  }
  return false
}

export function useAutomationNavigationRevision(
  navigation: PendingAutomationRunNavigation | null
): string {
  return useSyncExternalStore(onRuntimeEnvironmentRevisionsPublished, () =>
    navigation?.owner ? JSON.stringify(evaluateAutomationOwner(navigation.owner)) : ''
  )
}
