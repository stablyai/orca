import { samePtySourceDelivery, type PtySourceDeliverySnapshot } from './pty-source-credit-contract'

/** Parses actual counters against a validated capture; does not establish raw coverage or custody. */
export function parsePtyRetainedSourceDelivery(
  value: unknown,
  baseline: PtySourceDeliverySnapshot
): PtySourceDeliverySnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('pty_retained_source_delivery_invalid')
  }
  const delivery = value as PtySourceDeliverySnapshot
  if (
    !samePtySourceDelivery(delivery, baseline) ||
    delivery.windowSu !== baseline.windowSu ||
    delivery.state !== 'active' ||
    delivery.generationClosed !== false ||
    delivery.exitPublished !== false ||
    !Number.isSafeInteger(delivery.receivedEndSu) ||
    !Number.isSafeInteger(delivery.sentEndSu) ||
    !Number.isSafeInteger(delivery.creditedEndSu) ||
    delivery.receivedEndSu < baseline.receivedEndSu ||
    delivery.creditedEndSu < baseline.creditedEndSu ||
    delivery.sentEndSu < delivery.creditedEndSu ||
    delivery.sentEndSu > delivery.receivedEndSu ||
    delivery.sentEndSu - delivery.creditedEndSu > baseline.windowSu
  ) {
    throw new Error('pty_retained_source_delivery_invalid')
  }
  return Object.freeze({
    ...baseline,
    receivedEndSu: delivery.receivedEndSu,
    sentEndSu: delivery.sentEndSu,
    creditedEndSu: delivery.creditedEndSu
  })
}
