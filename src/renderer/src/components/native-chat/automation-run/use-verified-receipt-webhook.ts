import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import {
  onRuntimeEnvironmentRevisionsChanged,
  onRuntimeEnvironmentsRetired
} from '@/runtime/rpc/environment-revisions/runtime-environment-revision'
import { automationHookId } from '../../../../../shared/automation-event-triggers'
import type { NativeChatMessage } from '../../../../../shared/native-chat/native-chat-types'
import type { NativeChatVisualOwner } from '../media/visuals/native-chat-visual-owner'
import {
  automationReceiptSourceCurrent,
  captureAutomationReceiptSource,
  readAutomationReceipt,
  type AutomationReceiptSource
} from '../automation-receipt-client'

type AutomationSaved = NonNullable<NativeChatMessage['automationSaved']>

/**
 * The hook id of a webhook receipt this chat's host confirms as its own automation, still bound to
 * the pairing and runtime that confirmed it; otherwise null and the row stays a saved receipt.
 * A wait, a shortened body or an unverifiable receipt never gets the live setup card.
 */
export function useVerifiedReceiptWebhook(
  owner: NativeChatVisualOwner | null,
  itemId: string | undefined,
  saved: AutomationSaved,
  shortened: boolean
): string | null {
  const hookId = automationHookId(saved.automation)
  const eligible = hookId !== null && !saved.automation.once && !shortened
  const [verified, setVerified] = useState<AutomationReceiptSource | null>(null)
  // Why: a rebuilt transcript may hand over an equal saved body; only a different receipt rechecks.
  const latestSaved = useRef(saved)
  latestSaved.current = saved
  const automationId = saved.automation.id
  useEffect(() => {
    if (!eligible) {
      return
    }
    const source = captureAutomationReceiptSource(owner, itemId, latestSaved.current)
    if (!source) {
      return
    }
    let live = true
    const revoke = (): void => {
      if (!automationReceiptSourceCurrent(source)) {
        live = false
        setVerified((value) => (value === source ? null : value))
      }
    }
    const unsubscribers =
      source.target.kind === 'environment'
        ? [
            useAppStore.subscribe((state, previous) => {
              if (
                state.runtimeStatusByEnvironmentId !== previous.runtimeStatusByEnvironmentId ||
                state.runtimeEnvironments !== previous.runtimeEnvironments
              ) {
                revoke()
              }
            }),
            onRuntimeEnvironmentsRetired(revoke),
            onRuntimeEnvironmentRevisionsChanged(revoke)
          ]
        : []
    readAutomationReceipt(source).then(
      (read) => {
        if (live && automationReceiptSourceCurrent(source)) {
          const ours = read.status === 'ready' && automationHookId(read.automation) === hookId
          setVerified(ours ? source : null)
        }
      },
      () => {
        if (live) {
          setVerified(null)
        }
      }
    )
    return () => {
      live = false
      unsubscribers.forEach((unsubscribe) => unsubscribe())
    }
  }, [automationId, eligible, hookId, itemId, owner])
  return eligible &&
    verified !== null &&
    verified.itemId === itemId &&
    verified.automationId === saved.automation.id &&
    owner !== null &&
    verified.sessionId === owner.sessionId &&
    sameTarget(verified, owner) &&
    automationReceiptSourceCurrent(verified)
    ? hookId
    : null
}

function sameTarget(source: AutomationReceiptSource, owner: NativeChatVisualOwner): boolean {
  return owner.target.kind === 'local'
    ? source.target.kind === 'local'
    : source.target.kind === 'environment' &&
        source.target.environmentId === owner.target.environmentId
}
