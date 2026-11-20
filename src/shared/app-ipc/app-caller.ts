export type AppDocumentRole = 'main' | 'dashboard-popout' | 'workspace-space' | 'document'

export type AppCaller = Readonly<{
  documentId: string
  role: AppDocumentRole
  isMainFrame: boolean
  windowId: number | null
}>

export type AppDocumentTarget =
  | AppCaller
  | { documentId: string }
  | { sourceId: number }
  | { windowId: number }
  | 'all'
