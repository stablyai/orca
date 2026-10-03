export type WebRuntimeTabPropsMutation = {
  worktreeId: string
  tabId: string
  color?: string | null
  customTitle?: string | null
  previousCustomTitle?: string | null
  isPinned?: boolean
  viewMode?: 'terminal' | 'chat'
}
