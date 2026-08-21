export const DEFAULT_PTY_SOURCE_WINDOW_SU = 256 * 1024
export const MAX_PTY_ACK_ENTRIES = 64

export type PtySourceDeliveryIdentity = Readonly<{
  id: string
  providerGeneration: number
  clientGeneration: number
  ownerGeneration: number
  ptyIncarnation: string
  deliveryToken: string
}>

export type PtySourceTransform = Readonly<{
  transformed: boolean
  rawLengthSu: number
  scalarSafe: boolean
}>

export type PtySourceSpan = PtySourceDeliveryIdentity &
  Readonly<{
    spanId: string
    sourceStartSu: number
    sourceEndSu: number
    displayStart: number
    displayEnd: number
    data: string
    splittable?: boolean
    indivisible?: boolean
    transform: PtySourceTransform
  }>

export type PtySourceCreditAck = Readonly<{
  id: string
  clientGeneration: number
  ownerGeneration: number
  deliveryToken: string
  creditedEndSu: number
}>

export type PtySourceCreditAckBatch = Readonly<{
  acknowledgements: readonly PtySourceCreditAck[]
}>

export type PtySourceDeliveryCancellation = PtySourceDeliveryIdentity &
  Readonly<{
    reason: string
    sentEndSu: number
    creditedEndSu: number
    remainingStartSu: number
    remainingEndSu: number
    replacementDeliveryToken?: string
  }>

export type PtySourceDeliverySnapshot = PtySourceDeliveryIdentity &
  Readonly<{
    state: 'active' | 'sealed-unsettled' | 'closing' | 'closed'
    windowSu: number
    receivedEndSu: number
    sentEndSu: number
    creditedEndSu: number
    exitPublished: boolean
    generationClosed: boolean
  }>

export function ptySourceDeliveryKey(
  identity: Pick<PtySourceDeliveryIdentity, 'providerGeneration' | 'deliveryToken'>
): string {
  return `${identity.providerGeneration}\0${identity.deliveryToken}`
}

export function samePtySourceDelivery(
  left: PtySourceDeliveryIdentity,
  right: PtySourceDeliveryIdentity
): boolean {
  return (
    left.id === right.id &&
    left.providerGeneration === right.providerGeneration &&
    left.clientGeneration === right.clientGeneration &&
    left.ownerGeneration === right.ownerGeneration &&
    left.ptyIncarnation === right.ptyIncarnation &&
    left.deliveryToken === right.deliveryToken
  )
}

export function ptySourceSpanIsSplittable(
  span: Pick<PtySourceSpan, 'splittable' | 'indivisible'>
): boolean {
  return span.splittable ?? (span.indivisible !== undefined ? !span.indivisible : false)
}
