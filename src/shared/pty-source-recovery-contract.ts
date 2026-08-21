export type PtySourceRecoveryCheckpoint = Readonly<{
  status: 'checkpoint'
  clientGeneration: number
  ownerGeneration: number
  ptyIncarnation: string
  deliveryToken: string
  acceptedSourceEndSu: number
}>

export type PtySourceRecoveryRequest =
  | PtySourceRecoveryCheckpoint
  | Readonly<{ status: 'checkpointUnavailable' }>

export type PtySourceRecoveryPending = Readonly<{
  status: 'pending'
  clientGeneration: number
  ownerGeneration: number
  ptyIncarnation: string
  deliveryToken: string
  checkpointSourceEndSu: number
  recoveryEndSu: number
}>

export type PtySourceRecoveryResult =
  | PtySourceRecoveryPending
  | Readonly<{ status: 'restoreRequired'; reason: string }>

export type PtySourceRecoveryComplete = Omit<PtySourceRecoveryPending, 'status'> &
  Readonly<{ id: string }>
