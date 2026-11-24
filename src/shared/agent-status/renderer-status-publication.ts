import type { AgentStatusEntry } from './contracts/agent-status-types'

export type RendererStatusOccupant = {
  paneKey: string
  leafId: string
  rendererPtyId: string | null
}
export type RendererStatusRecord = RendererStatusOccupant & { row: AgentStatusEntry | null }
export type RendererStatusPublication = {
  type: 'snapshot' | 'changes'
  epoch: string
  seq: number
  rows: RendererStatusRecord[]
}
export type RendererStatusAck = {
  accepted: boolean
  snapshotRequired?: boolean
  reason?: 'superseded' | 'not-ready'
}

export function rendererStatusOccupantKey(occupant: RendererStatusOccupant): string {
  return JSON.stringify([occupant.paneKey, occupant.leafId, occupant.rendererPtyId])
}
