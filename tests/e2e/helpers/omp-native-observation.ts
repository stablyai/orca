export type NativeRef = {
  id: string
  kind: string
  parentId?: string
  status: string
  createdAt?: number
  isStreaming?: boolean
  pendingAsync?: boolean
}

export type NativeObservation = {
  at: number
  kind: string
  name?: string
  id?: string
  status?: string
  sessionId?: string
  sessionFile?: string
  ownerMatches?: boolean
  refs?: NativeRef[]
}
