import type { BrowserClientHostViewer } from '../../../../shared/browser/client-hosting/browser-client-host-placement'

// The client host's own viewer decision (main), read once before the tour shows; its copy depends on it.
let tourViewer: BrowserClientHostViewer | null = null

export function setClientHostedBrowserTourViewer(viewer: BrowserClientHostViewer | null): void {
  tourViewer = viewer
}

export function getClientHostedBrowserTourViewer(): BrowserClientHostViewer | null {
  return tourViewer
}
