export const EXTERNAL_EDITOR_RENDERER_UNAVAILABLE = 'renderer_unavailable'

export type ExternalEditorRequest = {
  requestId: string
  filePath: string
  wait: boolean
}

export type ExternalEditorResponse = {
  requestId: string
  status: 'opened' | 'closed' | 'error'
  error?: string
}

export type ExternalEditorResult = { filePath: string; closed: boolean }
