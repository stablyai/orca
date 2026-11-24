import { useEffect, useMemo, useRef, useState } from 'react'
import { automationHookId } from '../../../../../shared/automation-event-triggers'
import type { NativeChatMessage } from '../../../../../shared/native-chat/native-chat-types'
import type { NativeChatVisualOwner } from '../media/visuals/native-chat-visual-owner'
import type { WebhookHostTarget } from '@/components/bots/webhooks/webhook-host-client'
import {
  automationReceiptSourceCurrent,
  captureAutomationReceiptSource,
  readAutomationReceipt,
  watchAutomationReceiptHost,
  type AutomationReceiptSource
} from '../automation-receipt-client'

type AutomationSaved = NonNullable<NativeChatMessage['automationSaved']>

/** A webhook receipt its chat's host confirmed: the hook, the host bound to the confirming pairing
 *  and runtime for every Setup control, and the receipt's own bot. */
export type VerifiedReceiptWebhook = {
  hookId: string
  target: WebhookHostTarget
  botId: string | undefined
}

/**
 * The webhook receipt this chat's host confirms as its own automation, still bound to the pairing
 * and runtime that confirmed it; otherwise null and the row stays a saved receipt.
 * A wait, a shortened body or an unverifiable receipt never gets the live setup card.
 */
export function useVerifiedReceiptWebhook(
  owner: NativeChatVisualOwner | null,
  itemId: string | undefined,
  saved: AutomationSaved,
  shortened: boolean
): VerifiedReceiptWebhook | null {
  const hookId = automationHookId(saved.automation)
  const eligible = hookId !== null && !saved.automation.once && !shortened
  const [verified, setVerified] = useState<AutomationReceiptSource | null>(null)
  const target = useMemo(() => (verified ? boundWebhookTarget(verified) : null), [verified])
  // Why: a rebuilt transcript may hand over an equal saved body; only a different receipt rechecks.
  const latestSaved = useRef(saved)
  useEffect(() => {
    latestSaved.current = saved
  }, [saved])
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
    const withdraw = (): void => {
      live = false
      setVerified((value) => (value === source ? null : value))
    }
    // Why: only a remote host can change under a confirmed receipt; a local one is always current.
    const unwatchHost = watchAutomationReceiptHost(source, withdraw)
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
      unwatchHost()
    }
  }, [automationId, eligible, hookId, itemId, owner])
  return eligible &&
    verified !== null &&
    target !== null &&
    verified.itemId === itemId &&
    verified.automationId === saved.automation.id &&
    owner !== null &&
    verified.sessionId === owner.sessionId &&
    sameTarget(verified, owner) &&
    automationReceiptSourceCurrent(verified)
    ? { hookId, target, botId: verified.botId }
    : null
}

/** The confirming host as the Setup controls' only target: a paired one pinned to its incarnation. */
function boundWebhookTarget(source: AutomationReceiptSource): WebhookHostTarget | null {
  if (source.target.kind === 'local') {
    return source.target
  }
  const { pairingRevision, runtimeId } = source
  if (pairingRevision === undefined || runtimeId === undefined) {
    return null
  }
  return {
    kind: 'environment',
    environmentId: source.target.environmentId,
    binding: {
      pairingRevision,
      runtimeId,
      current: () => automationReceiptSourceCurrent(source)
    }
  }
}

function sameTarget(source: AutomationReceiptSource, owner: NativeChatVisualOwner): boolean {
  return owner.target.kind === 'local'
    ? source.target.kind === 'local'
    : source.target.kind === 'environment' &&
        source.target.environmentId === owner.target.environmentId
}
