import type { BrowserPageConversionOrigin } from '../../../../../shared/browser-workspace-types'

export type HtmlDocPreviewProps = {
  previewId: string
  browserWorkspaceId: string
  filePath: string
  relativePath: string
  worktreeId: string
  /** Whether this preview is the surface the reader is in, and so may hold the keyboard. */
  holdsGuestFocus?: boolean
  isActive?: boolean
  runtimeEnvironmentId?: string | null
  externalSshTargetId?: string | null
  /** Set when the address bar converted this page; Back returns across it once guest history runs out. */
  convertedFrom?: BrowserPageConversionOrigin | null
  /** Set when Back returned across a conversion to this page; Forward re-crosses it. */
  convertedTo?: BrowserPageConversionOrigin | null
}
