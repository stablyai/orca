/** Reads selected history through its captured owner, with a fresh answer for each run navigation. */

import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import type { AutomationRun } from '../../../../shared/automations-types'
import type { AutomationAuthorityRef } from '../../../../shared/automation-owner-ref'
import { capturedAutomationOwner, capturedAutomationOwnerKey } from './automation-captured-owner'
import type { AutomationListRow } from './automation-list-row-identity'
import {
  type AutomationActionNotice,
  type AutomationDispatchContext,
  dispatchAutomationRunHistory
} from './automation-row-action-dispatch'
import {
  getAutomationAuthorityTarget,
  getAutomationHostTargetKey,
  getAutomationTargetFromHostId,
  listAutomationRunsForTarget,
  type AutomationHostTarget
} from './automation-host-client'

export type SelectedAutomationRunNavigation = {
  automationId: string
  runId: string | null
  hostId?: string | null
} | null

export type SelectedAutomationRunHistoryOutcome = {
  automationId: string | null
  /** Which listed row was asked; an ID alone cannot name one of two hosts' copies. */
  rowKey: string | null
  /** Which incarnation answered; a re-pairing makes the same row's answer stale. */
  ownerKey: string | null
  /** The exact navigation this read answered, including repeated clicks on the same run. */
  navigation: SelectedAutomationRunNavigation
  reloadToken: number
  runs: AutomationRun[]
  /** A failed/refused read leaves history unknown; never present it as zero runs. */
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
  const settledRequestRef = useRef<{
    fetchKey: string
    reloadToken: number
    authority: AutomationAuthorityRef
  } | null>(null)

  const automationId = input.selected?.automation.id ?? null
  const rowKey = input.selected?.key ?? null
  const reloadToken = input.reloadToken
  const navigation =
    input.navigation?.runId && input.navigation.automationId === automationId
      ? input.navigation
      : null
  const captured = input.selected
    ? capturedAutomationOwner(input.context.capturedOwners, input.selected.key).owner
    : null
  const authority = captured?.authority ?? input.context.authority
  const rowAuthority = useMemo<AutomationAuthorityRef>(
    () => (authority?.kind === 'runtime' ? authority : { kind: 'desktop' }),
    [authority]
  )
  const navigationHost = automationId ? navigationHostId(input.navigation, automationId) : null
  const target = captured
    ? getAutomationAuthorityTarget(captured.authority)
    : navigationHost
      ? getAutomationTargetFromHostId(navigationHost)
      : input.selected
        ? (input.legacyTarget(input.selected) ?? { kind: 'local' as const })
        : { kind: 'local' as const }
  const fetchKey =
    automationId && rowKey
      ? [
          rowKey,
          capturedAutomationOwnerKey(capturedAutomationOwner(input.context.capturedOwners, rowKey)),
          getAutomationHostTargetKey(target)
        ].join('|')
      : ''
  const inputRef = useRef({ ...input, target })
  useLayoutEffect(() => {
    inputRef.current = { ...input, target }
  })

  useEffect(() => {
    const { selected, context, onSettled, target: requestTarget } = inputRef.current
    if (!selected || !automationId || !rowKey) {
      settledRequestRef.current = null
      onSettled({
        automationId: null,
        rowKey: null,
        ownerKey: null,
        navigation: null,
        reloadToken,
        runs: [],
        notice: null
      })
      return
    }
    const settled = settledRequestRef.current
    if (
      !navigation &&
      settled?.fetchKey === fetchKey &&
      settled.reloadToken === reloadToken &&
      settled.authority === rowAuthority
    ) {
      return
    }
    settledRequestRef.current = null
    let cancelled = false
    const owner = capturedAutomationOwnerKey(
      capturedAutomationOwner(context.capturedOwners, rowKey)
    )
    void dispatchAutomationRunHistory(
      context,
      { rowKey, automationId },
      () => listAutomationRunsForTarget(requestTarget, automationId),
      rowAuthority
    ).then((result) => {
      if (cancelled) {
        return
      }
      settledRequestRef.current = { fetchKey, reloadToken, authority: rowAuthority }
      onSettled({
        automationId,
        rowKey,
        ownerKey: owner,
        navigation,
        reloadToken,
        runs: result.ok ? result.value : [],
        notice: result.ok ? null : result.notice
      })
    })
    return () => {
      cancelled = true
    }
  }, [automationId, rowAuthority, rowKey, fetchKey, reloadToken, navigation])
}
