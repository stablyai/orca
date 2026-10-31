/**
 * Fetches only the selected automation's history, through its captured owner.
 *
 * The refetch policy is a string key rather than the objects the fetch reads:
 * the dispatch context is rebuilt on every cache reprojection, and keying an
 * effect on it re-asks the same host for the same history in a loop. What
 * actually decides the request is the row, the owner it was listed under, and
 * the host a navigation named. Matching lifecycle events re-read that same acquisition.
 */

import { useEffect, useLayoutEffect, useRef } from 'react'
import type { AutomationRun } from '../../../../shared/automations-types'
import type { AutomationAuthorityRef } from '../../../../shared/automation-owner-ref'
import {
  capturedAutomationOwner,
  capturedAutomationOwnerKey,
  type AutomationCapturedOwner
} from './automation-captured-owner'
import type { AutomationListRow } from './automation-list-row-identity'
import {
  type AutomationActionNotice,
  type AutomationDispatchContext,
  dispatchAutomationRunHistory
} from './automation-row-action-dispatch'
import {
  getAutomationAuthorityTarget,
  getAutomationTargetFromHostId,
  listAutomationRunsForTarget,
  type AutomationHostTarget
} from './automation-host-client'
import { useAppStore } from '@/store'
import { automationRuntimePairingRevision } from './automation-authority-identity'
import { automationAuthorityCatalogKey } from './automation-host-catalog-types'
import { isSameStableAutomationHost } from '../../../../shared/automation-owner-key'
import { subscribeAutomationHostInvalidation } from './automation-host-invalidation-window-events'

export type SelectedAutomationRunNavigation = {
  automationId: string
  runId?: string | null
  hostId?: string | null
} | null

export type SelectedAutomationRunHistoryOutcome = {
  automationId: string | null
  /** Which listed row was asked; an ID alone cannot name one of two hosts' copies. */
  rowKey: string | null
  /** Which incarnation answered; a re-pairing makes the same row's answer stale. */
  ownerKey: string | null
  authority: AutomationAuthorityRef | null
  capturedOwner?: AutomationCapturedOwner
  navigation: SelectedAutomationRunNavigation
  reloadToken: number
  runs: AutomationRun[]
  /**
   * Non-null when the host refused or failed the read. The runs are then unknown
   * rather than absent, and the caller must say so instead of showing zero runs.
   */
  notice: AutomationActionNotice | null
}

export type SelectedAutomationRunHistoryInput = {
  selected: AutomationListRow | null
  selection?: { automationId: string | null; rowKey: string | null }
  retained?: SelectedAutomationRunHistoryOutcome
  context: AutomationDispatchContext
  /** The row's own host, used only when no owner was captured for it. */
  legacyTarget: (row: AutomationListRow) => AutomationHostTarget | null
  navigation: SelectedAutomationRunNavigation
  /** Changing this re-asks the host; it is how a failed read offers Retry. */
  reloadToken: number
  acquisitionToken?: number
  onSettled: (outcome: SelectedAutomationRunHistoryOutcome) => void
}

function navigationHostId(
  navigation: SelectedAutomationRunNavigation,
  automationId: string
): string | null {
  return navigation?.automationId === automationId ? (navigation.hostId ?? null) : null
}

export function useSelectedAutomationRunHistory(input: SelectedAutomationRunHistoryInput): void {
  const acquired = useRef<{
    selected: AutomationListRow
    context: AutomationDispatchContext
    captured: AutomationCapturedOwner
    target: AutomationHostTarget
    authority: AutomationAuthorityRef
    token: number | undefined
  } | null>(null)
  const selected = input.selected
  const previous = acquired.current
  let request = previous
  if (
    selected &&
    (!previous ||
      previous.selected.key !== selected.key ||
      previous.token !== input.acquisitionToken)
  ) {
    const captured = capturedAutomationOwner(input.context.capturedOwners, selected.key)
    const navigationHost = navigationHostId(input.navigation, selected.automation.id)
    const target = captured.owner
      ? getAutomationAuthorityTarget(captured.owner.authority)
      : navigationHost
        ? getAutomationTargetFromHostId(navigationHost)
        : (input.legacyTarget(selected) ?? { kind: 'local' as const })
    const authority: AutomationAuthorityRef =
      captured.owner?.authority ??
      (target.kind === 'environment'
        ? {
            kind: 'runtime',
            environmentId: target.environmentId,
            pairingRevision: automationRuntimePairingRevision(
              useAppStore.getState().runtimeEnvironments,
              target.environmentId
            )
          }
        : { kind: 'desktop' })
    request = {
      selected,
      captured,
      target,
      authority,
      token: input.acquisitionToken,
      context: { authority, capturedOwners: new Map([[selected.key, captured]]) }
    }
  } else if (
    !selected &&
    (input.selection?.automationId !== acquired.current?.selected.automation.id ||
      input.selection?.rowKey !== acquired.current?.selected.key)
  ) {
    request = null
  }
  const inputRef = useRef(input)
  useLayoutEffect(() => {
    acquired.current = request
    inputRef.current = input
  })
  const reloadToken = input.reloadToken
  const navigation =
    input.navigation?.runId && input.navigation.automationId === request?.selected.automation.id
      ? input.navigation
      : null
  const settled = useRef<{ request: typeof request; reloadToken: number } | null>(null)

  useEffect(() => {
    const { onSettled } = inputRef.current
    if (!request) {
      onSettled({
        automationId: null,
        rowKey: null,
        ownerKey: null,
        authority: null,
        navigation: null,
        reloadToken,
        runs: [],
        notice: null
      })
      return
    }
    let cancelled = false
    let requestId = 0
    const { selected, context, captured, target, authority: rowAuthority } = request
    const automationId = selected.automation.id
    const rowKey = selected.key
    const owner = capturedAutomationOwnerKey(captured)
    const read = (): void => {
      const currentRequestId = ++requestId
      settled.current = null
      void dispatchAutomationRunHistory(
        context,
        { rowKey, automationId },
        () =>
          listAutomationRunsForTarget(
            target,
            automationId,
            rowAuthority.kind === 'runtime' ? rowAuthority.pairingRevision : undefined
          ),
        rowAuthority
      ).then((result) => {
        if (cancelled || requestId !== currentRequestId) {
          return
        }
        settled.current = { request, reloadToken }
        // A refused or failed read still settles: leaving the previous automation's
        // ID in place strands anything waiting on this one and shows its runs as zero.
        onSettled(
          result.ok
            ? {
                automationId,
                rowKey,
                ownerKey: owner,
                authority: rowAuthority,
                navigation,
                reloadToken,
                ...(captured.owner || captured.selector ? { capturedOwner: captured } : {}),
                runs: result.value,
                notice: null
              }
            : {
                automationId,
                rowKey,
                ownerKey: owner,
                authority: rowAuthority,
                navigation,
                reloadToken,
                ...(captured.owner || captured.selector ? { capturedOwner: captured } : {}),
                runs:
                  inputRef.current.retained?.rowKey === rowKey &&
                  inputRef.current.retained.ownerKey === owner
                    ? inputRef.current.retained.runs
                    : [],
                notice: result.notice
              }
        )
      })
    }
    const selector = captured.owner?.selector ?? captured.selector ?? selected.catalogRef?.selector
    const unsubscribe = subscribeAutomationHostInvalidation((event) => {
      if (
        automationAuthorityCatalogKey(event.authority) !==
          automationAuthorityCatalogKey(rowAuthority) ||
        (event.selector &&
          (!selector ||
            !isSameStableAutomationHost(
              selector.kind === 'orphan'
                ? { authority: rowAuthority, selector: { kind: 'orphan' } }
                : { authority: rowAuthority, selector },
              event.selector.kind === 'orphan'
                ? { authority: event.authority, selector: { kind: 'orphan' } }
                : { authority: event.authority, selector: event.selector }
            )))
      ) {
        return
      }
      read()
    })
    if (
      navigation ||
      settled.current?.request !== request ||
      settled.current.reloadToken !== reloadToken
    ) {
      read()
    }
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [request, reloadToken, navigation])
}
