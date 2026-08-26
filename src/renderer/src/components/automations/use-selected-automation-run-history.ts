/**
 * Fetches only the selected automation's history, through its captured owner.
 *
 * The refetch policy is a string key rather than the objects the fetch reads:
 * the dispatch context is rebuilt on every cache reprojection, and keying an
 * effect on it re-asks the same host for the same history in a loop. What
 * actually decides the request is the row, the owner it was listed under, and
 * the host a navigation named — so those, and only those, are the key.
 */

import { useEffect, useRef } from 'react'
import type { AutomationRun } from '../../../../shared/automations-types'
import { capturedAutomationOwner, capturedAutomationOwnerKey } from './automation-captured-owner'
import type { AutomationListRow } from './automation-list-row-identity'
import {
  type AutomationActionNotice,
  type AutomationDispatchContext,
  dispatchAutomationRunHistory
} from './automation-row-action-dispatch'
import {
  getAutomationTargetFromHostId,
  listAutomationRunsForTarget,
  type AutomationHostTarget
} from './automation-host-client'

export type SelectedAutomationRunNavigation = {
  automationId: string
  hostId?: string | null
} | null

export type SelectedAutomationRunHistoryOutcome = {
  automationId: string | null
  /** Which listed row was asked; an ID alone cannot name one of two hosts' copies. */
  rowKey: string | null
  /** Which incarnation answered; a re-pairing makes the same row's answer stale. */
  ownerKey: string | null
  runs: AutomationRun[]
  /**
   * Non-null when the host refused or failed the read. The runs are then unknown
   * rather than absent, and the caller must say so instead of showing zero runs.
   */
  notice: AutomationActionNotice | null
}

export type SelectedAutomationRunHistoryInput = {
  selected: AutomationListRow | null
  context: AutomationDispatchContext
  /** The row's own host, used only when no owner was captured for it. */
  legacyTarget: (row: AutomationListRow) => AutomationHostTarget | null
  navigation: SelectedAutomationRunNavigation
  /** Changing this re-asks the host; it is how a failed read offers Retry. */
  reloadToken: number
  onSettled: (outcome: SelectedAutomationRunHistoryOutcome) => void
}

function navigationHostId(
  navigation: SelectedAutomationRunNavigation,
  automationId: string
): string | null {
  return navigation?.automationId === automationId ? (navigation.hostId ?? null) : null
}

export function useSelectedAutomationRunHistory(input: SelectedAutomationRunHistoryInput): void {
  const inputRef = useRef(input)
  inputRef.current = input

  const automationId = input.selected?.automation.id ?? null
  const rowKey = input.selected?.key ?? null
  const reloadToken = input.reloadToken
  const fetchKey =
    automationId && rowKey
      ? [
          rowKey,
          capturedAutomationOwnerKey(capturedAutomationOwner(input.context.capturedOwners, rowKey)),
          navigationHostId(input.navigation, automationId) ?? ''
        ].join('|')
      : ''

  useEffect(() => {
    const { selected, context, legacyTarget, navigation, onSettled } = inputRef.current
    if (!selected || !automationId || !rowKey) {
      onSettled({ automationId: null, rowKey: null, ownerKey: null, runs: [], notice: null })
      return
    }
    let cancelled = false
    const owner = capturedAutomationOwnerKey(
      capturedAutomationOwner(context.capturedOwners, rowKey)
    )
    const navigationHost = navigationHostId(navigation, automationId)
    const target = navigationHost
      ? getAutomationTargetFromHostId(navigationHost)
      : (legacyTarget(selected) ?? { kind: 'local' })
    void dispatchAutomationRunHistory(context, { rowKey, automationId }, () =>
      listAutomationRunsForTarget(target, automationId)
    ).then((result) => {
      if (cancelled) {
        return
      }
      // A refused or failed read still settles: leaving the previous automation's
      // ID in place strands anything waiting on this one and shows its runs as zero.
      onSettled(
        result.ok
          ? { automationId, rowKey, ownerKey: owner, runs: result.value, notice: null }
          : { automationId, rowKey, ownerKey: owner, runs: [], notice: result.notice }
      )
    })
    return () => {
      cancelled = true
    }
  }, [automationId, rowKey, fetchKey, reloadToken])
}
