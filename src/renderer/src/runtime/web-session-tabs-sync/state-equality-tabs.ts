import type {
  BrowserCertificateFailure,
  BrowserPage,
  BrowserWorkspace
} from '../../../../shared/browser-workspace-types'
import type { RuntimeBrowserPlacement } from '../../../../shared/runtime-browser-placement'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { sameRuntimeBrowserPlacement } from '../../../../shared/runtime-browser-placement'
import { sameStringArray } from './state-equality-core'

export function terminalTabEqual(a: TerminalTab, b: TerminalTab): boolean {
  return (
    a.id === b.id &&
    a.ptyId === b.ptyId &&
    a.worktreeId === b.worktreeId &&
    a.title === b.title &&
    a.defaultTitle === b.defaultTitle &&
    a.quickCommandLabel === b.quickCommandLabel &&
    a.startupCwd === b.startupCwd &&
    a.generatedTitle === b.generatedTitle &&
    a.aiVaultTitle?.agent === b.aiVaultTitle?.agent &&
    a.aiVaultTitle?.sessionId === b.aiVaultTitle?.sessionId &&
    a.aiVaultTitle?.title === b.aiVaultTitle?.title &&
    a.customTitle === b.customTitle &&
    a.color === b.color &&
    a.sortOrder === b.sortOrder &&
    a.createdAt === b.createdAt &&
    a.generation === b.generation &&
    a.shellOverride === b.shellOverride &&
    a.launchAgent === b.launchAgent &&
    a.pendingActivationSpawn === b.pendingActivationSpawn
  )
}

export function sameTerminalTabs(
  a: readonly TerminalTab[] | undefined,
  b: readonly TerminalTab[] | null
): boolean {
  const left = a ?? []
  const right = b ?? []
  if (left.length !== right.length) {
    return false
  }
  return left.every((tab, index) => terminalTabEqual(tab, right[index]!))
}

export function browserPageEqual(a: BrowserPage, b: BrowserPage): boolean {
  return (
    a.id === b.id &&
    a.workspaceId === b.workspaceId &&
    a.worktreeId === b.worktreeId &&
    a.url === b.url &&
    a.title === b.title &&
    a.loading === b.loading &&
    a.faviconUrl === b.faviconUrl &&
    a.canGoBack === b.canGoBack &&
    a.canGoForward === b.canGoForward &&
    a.loadError?.code === b.loadError?.code &&
    a.loadError?.description === b.loadError?.description &&
    a.loadError?.validatedUrl === b.loadError?.validatedUrl &&
    a.createdAt === b.createdAt &&
    a.browserRuntimeEnvironmentId === b.browserRuntimeEnvironmentId &&
    a.viewportPresetId === b.viewportPresetId
  )
}

export function optionalRuntimeBrowserPlacementsEqual(
  left: RuntimeBrowserPlacement | undefined,
  right: RuntimeBrowserPlacement | undefined
): boolean {
  return left === undefined
    ? right === undefined
    : right !== undefined && sameRuntimeBrowserPlacement(left, right)
}

export function browserCertificateFailureEqual(
  a: BrowserCertificateFailure | null | undefined,
  b: BrowserCertificateFailure | null | undefined
): boolean {
  const left = a ?? null
  const right = b ?? null
  if (left === right) {
    return true
  }
  return Boolean(
    left &&
    right &&
    left.challengeId === right.challengeId &&
    left.browserPageId === right.browserPageId &&
    left.errorCode === right.errorCode &&
    left.error === right.error &&
    left.origin === right.origin &&
    left.displayHost === right.displayHost &&
    left.canProceed === right.canProceed &&
    left.observedAt === right.observedAt
  )
}

export function sameBrowserPages(
  a: readonly BrowserPage[] | undefined,
  b: readonly BrowserPage[] | null
): boolean {
  const left = a ?? []
  const right = b ?? []
  if (left.length !== right.length) {
    return false
  }
  return left.every((page, index) => browserPageEqual(page, right[index]!))
}

export function browserWorkspaceEqual(a: BrowserWorkspace, b: BrowserWorkspace): boolean {
  return (
    a.id === b.id &&
    a.worktreeId === b.worktreeId &&
    a.label === b.label &&
    a.sessionProfileId === b.sessionProfileId &&
    a.activePageId === b.activePageId &&
    sameStringArray(a.pageIds ?? [], b.pageIds ?? []) &&
    a.url === b.url &&
    a.title === b.title &&
    a.loading === b.loading &&
    a.faviconUrl === b.faviconUrl &&
    a.canGoBack === b.canGoBack &&
    a.canGoForward === b.canGoForward &&
    a.loadError?.code === b.loadError?.code &&
    a.loadError?.description === b.loadError?.description &&
    a.loadError?.validatedUrl === b.loadError?.validatedUrl &&
    a.createdAt === b.createdAt
  )
}

export function sameBrowserTabs(
  a: readonly BrowserWorkspace[] | undefined,
  b: readonly BrowserWorkspace[] | null
): boolean {
  const left = a ?? []
  const right = b ?? []
  if (left.length !== right.length) {
    return false
  }
  return left.every((tab, index) => browserWorkspaceEqual(tab, right[index]!))
}
