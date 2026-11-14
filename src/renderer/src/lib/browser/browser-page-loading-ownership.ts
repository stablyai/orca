import type { BrowserPage } from '../../../../shared/browser-workspace-types'

export type BrowserPageLoadingOwner = { active: boolean }

const loadingOwners = new WeakMap<BrowserPage, BrowserPageLoadingOwner>()

export function readBrowserPageLoadingOwner(
  page: BrowserPage | undefined
): BrowserPageLoadingOwner | undefined {
  const owner = page && loadingOwners.get(page)
  return owner?.active ? owner : undefined
}

export function revokeBrowserPageLoadingOwner(page: BrowserPage): void {
  const owner = loadingOwners.get(page)
  if (owner) {
    owner.active = false
    loadingOwners.delete(page)
  }
}

export function preserveBrowserPageLoadingOwner(previous: BrowserPage, next: BrowserPage): void {
  const owner = readBrowserPageLoadingOwner(previous)
  if (owner && previous !== next) {
    loadingOwners.delete(previous)
    loadingOwners.set(next, owner)
  }
}

export function assignBrowserPageLoadingOwner(
  previous: BrowserPage,
  next: BrowserPage,
  owner?: BrowserPageLoadingOwner
): void {
  revokeBrowserPageLoadingOwner(previous)
  if (owner?.active) {
    loadingOwners.set(next, owner)
  }
}
