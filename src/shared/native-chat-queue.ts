export type NativeChatQueuedMessage = {
  id: string
  text: string
  imagePaths: string[]
  createdAt: number
  state: 'pending' | 'submitting' | 'paused' | 'uncertain'
  error?: string
  kind: 'chat' | 'command'
}

export type NativeChatQueueSnapshot = {
  paneKey: string
  revision: number
  items: NativeChatQueuedMessage[]
  paused?: 'failed' | 'interrupted'
}
