export type PtySourceDeliveryIdentity = Readonly<{
  id: string
  providerGeneration: number
  clientGeneration: number
  ownerGeneration: number
  ptyIncarnation: string
  deliveryToken: string
}>

type PtySourceTransform = Readonly<{
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
