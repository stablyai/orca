export const CHAT_ADDRESS_PREVIEW_LIMIT = 8

/** Protocol identifiers, localized only when the preview view renders an error. */
export const CHAT_ADDRESS_PREVIEW_CLIENT_ERROR = {
  unavailable: 'address-preview:unavailable',
  desktopRequired: 'address-preview:desktop-required'
} as const

export type ChatAddressPreviewKind =
  | 'image'
  | 'audio'
  | 'video'
  | 'text'
  | 'markdown'
  | 'pdf'
  | 'file'

export type ChatAddressPreviewRequest = {
  id: string
  source: string
  allowPrivateNetwork?: boolean
}

export type ChatAddressPreviewResult =
  | {
      status: 'ready'
      id: string
      name: string
      kind: ChatAddressPreviewKind
      mimeType: string
      size?: number
      url?: string
      /** UTF-8 text/Markdown, or base64 PDF bytes. Media bodies remain streamed. */
      content?: string
    }
  | { status: 'permission-required'; id: string; message: string }
  | { status: 'error'; id: string; message: string }

export type ChatAddressPreviewEntry = {
  id: string
  source: string
  result: ChatAddressPreviewResult | null
}
