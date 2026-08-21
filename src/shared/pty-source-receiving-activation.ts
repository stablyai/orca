export type PtySourceReceivingActivation = Readonly<{
  status: 'pending'
  clientGeneration: number
  ownerGeneration: number
  ptyIncarnation: string
  deliveryToken: string
  checkpointSourceEndSu: number
  recoveryEndSu: number
}>

export function parsePtySourceReceivingActivation(
  value: unknown
): PtySourceReceivingActivation | undefined {
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid SSH PTY source activation response')
  }
  const input = value as Record<string, unknown>
  if (
    input.status !== 'pending' ||
    typeof input.deliveryToken !== 'string' ||
    input.deliveryToken.length === 0 ||
    typeof input.ptyIncarnation !== 'string' ||
    input.ptyIncarnation.length === 0 ||
    !positiveInteger(input.clientGeneration) ||
    !positiveInteger(input.ownerGeneration) ||
    !nonNegativeInteger(input.checkpointSourceEndSu) ||
    !nonNegativeInteger(input.recoveryEndSu) ||
    Number(input.recoveryEndSu) < Number(input.checkpointSourceEndSu)
  ) {
    throw new Error('Invalid SSH PTY source activation response')
  }
  return Object.freeze({
    status: 'pending',
    clientGeneration: Number(input.clientGeneration),
    ownerGeneration: Number(input.ownerGeneration),
    ptyIncarnation: input.ptyIncarnation,
    deliveryToken: input.deliveryToken,
    checkpointSourceEndSu: Number(input.checkpointSourceEndSu),
    recoveryEndSu: Number(input.recoveryEndSu)
  })
}

function positiveInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) > 0
}

function nonNegativeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0
}
