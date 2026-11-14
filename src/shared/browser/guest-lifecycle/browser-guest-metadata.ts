import type { BrowserLoadError } from '../../browser-workspace-types'

export type BrowserGuestMetadata = {
  browserPageId: string
  webContentsId: number
  revision: number
  navigationRevision: number
  kind: 'snapshot' | 'navigation' | 'in-page' | 'title' | 'start' | 'stop' | 'failure' | 'retired'
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  errorPage: boolean
  loadError: BrowserLoadError | null
  hasCertificateFailure: boolean
}
