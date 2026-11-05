import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'
import { ORCA_BROWSER_BLANK_URL } from '../../../../../shared/constants'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../shared/layout-owner-switch'
import type { BrowserTabInfo } from '../../../../../shared/runtime-types'
import { isRemoteBrowserPageMissingError } from './remote-browser-stream-errors'
import type {
  RemoteBrowserOperationToken,
  RemoteBrowserOperationTokens
} from './remote-browser-stream-tokens'

export type RemoteBrowserRpcCall = <TResult>(
  target: RuntimeClientTarget,
  method: string,
  params?: unknown,
  options?: { timeoutMs?: number; suppressFeatureInteraction?: boolean }
) => Promise<TResult>

export type RemoteBrowserPageHandle = {
  environmentId: string
  remotePageId: string
}

export type RemoteBrowserPageSessionDeps = {
  tokens: RemoteBrowserOperationTokens
  callRpc: RemoteBrowserRpcCall
  getWorktreeSelector(): string
  getCurrentUrl(): string
  readStoredHandle(): RemoteBrowserPageHandle | null
  writeStoredHandle(handle: RemoteBrowserPageHandle): void
  removeStoredHandle(remotePageId: string): void
  applyTabInfo(tab: Pick<BrowserTabInfo, 'url' | 'title'>): void
  closeMissingRemotePage(remotePageId: string | null): void
}

// Keep runtime page identity and post-input refresh separate from screencast ownership.
export class RemoteBrowserPageSession {
  private tabRefreshTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly deps: RemoteBrowserPageSessionDeps) {}

  async fetchTabInfo(token: RemoteBrowserOperationToken): Promise<BrowserTabInfo | null> {
    if (!this.deps.tokens.isCurrent(token) || !token.remotePageId) {
      return null
    }
    const shown = await this.deps.callRpc<{ tab: BrowserTabInfo }>(
      { kind: 'environment', environmentId: token.environmentId },
      'browser.tabShow',
      { worktree: this.deps.getWorktreeSelector(), page: token.remotePageId },
      { timeoutMs: 15_000, suppressFeatureInteraction: true }
    )
    return shown.tab
  }

  async ensureRemotePage(token: RemoteBrowserOperationToken): Promise<string | null> {
    const { tokens } = this.deps
    if (!tokens.isCurrent(token)) {
      return null
    }
    const existingHandle = this.deps.readStoredHandle()
    if (existingHandle?.environmentId !== token.environmentId) {
      // Switch point: a frame-drawn host tab has no handle, but its row id is the host's page id.
      if (ORCA_LAYOUT_OWNER_IS_MAIN) {
        const adopted = await this.adoptHostPage(token)
        if (adopted !== undefined) {
          return adopted
        }
      }
      return this.createRemotePage(token)
    }
    tokens.setRemotePage(existingHandle.remotePageId)
    try {
      const cachedTab = await this.fetchTabInfo({
        ...token,
        remotePageId: existingHandle.remotePageId
      })
      return cachedTab ? existingHandle.remotePageId : null
    } catch (error) {
      if (!isRemoteBrowserPageMissingError(error)) {
        throw error
      }
      this.deps.removeStoredHandle(existingHandle.remotePageId)
      if (tokens.remotePage === existingHandle.remotePageId) {
        tokens.setRemotePage(null)
      }
      if (tokens.isCurrent(token)) {
        this.deps.closeMissingRemotePage(existingHandle.remotePageId)
      }
      return null
    }
  }

  scheduleTabInfoRefresh(token: RemoteBrowserOperationToken, delayMs = 250): void {
    const { tokens } = this.deps
    if (!tokens.isCurrent(token)) {
      return
    }
    this.cancelTabInfoRefresh()
    this.tabRefreshTimer = setTimeout(() => {
      this.tabRefreshTimer = null
      if (!tokens.isCurrent(token)) {
        return
      }
      void this.fetchTabInfo(token)
        .then((tab) => {
          if (tab && tokens.isCurrent(token)) {
            this.deps.applyTabInfo(tab)
          }
        })
        .catch((error: unknown) => {
          if (tokens.isCurrent(token) && isRemoteBrowserPageMissingError(error)) {
            this.deps.closeMissingRemotePage(token.remotePageId)
          }
        })
    }, delayMs)
  }

  cancelTabInfoRefresh(): void {
    if (this.tabRefreshTimer !== null) {
      clearTimeout(this.tabRefreshTimer)
      this.tabRefreshTimer = null
    }
  }

  /** The row's own id when the host runs that page; undefined when the host has none, so create. */
  private async adoptHostPage(
    token: RemoteBrowserOperationToken
  ): Promise<string | null | undefined> {
    const { tokens } = this.deps
    const provisional = token.tabId
    const probe = { ...token, remotePageId: provisional }
    const release = (): void => {
      if (tokens.remotePage === provisional) {
        tokens.setRemotePage(null)
      }
    }
    tokens.setRemotePage(provisional)
    try {
      // tabShow also starts a saved page the host has not opened yet.
      if (!(await this.fetchTabInfo(probe)) || !tokens.isCurrent(probe)) {
        release()
        return null
      }
    } catch (error) {
      release()
      // Only a page the host truly lacks is created; a timeout must not duplicate a live page.
      if (!isRemoteBrowserPageMissingError(error)) {
        throw error
      }
      // A handle-less row has nothing to close.
      return tokens.isCurrent(token) ? undefined : null
    }
    this.deps.writeStoredHandle({ environmentId: token.environmentId, remotePageId: provisional })
    return provisional
  }

  private async createRemotePage(token: RemoteBrowserOperationToken): Promise<string | null> {
    const target: RuntimeClientTarget = { kind: 'environment', environmentId: token.environmentId }
    const worktree = this.deps.getWorktreeSelector()
    const currentUrl = this.deps.getCurrentUrl()
    const initialUrl =
      currentUrl === ORCA_BROWSER_BLANK_URL ? 'about:blank' : currentUrl || 'about:blank'
    const created = await this.deps.callRpc<{ browserPageId: string }>(
      target,
      'browser.tabCreate',
      { worktree, url: initialUrl },
      { timeoutMs: 30_000, suppressFeatureInteraction: true }
    )
    if (!this.deps.tokens.isCurrent(token)) {
      void this.deps
        .callRpc(
          target,
          'browser.tabClose',
          { worktree, page: created.browserPageId },
          { timeoutMs: 15_000, suppressFeatureInteraction: true }
        )
        .catch(() => {})
      return null
    }
    this.deps.tokens.setRemotePage(created.browserPageId)
    this.deps.writeStoredHandle({
      environmentId: target.environmentId,
      remotePageId: created.browserPageId
    })
    return created.browserPageId
  }
}
