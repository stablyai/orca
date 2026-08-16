import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { ORCA_BROWSER_BLANK_URL } from '../../../../shared/constants'
import type { BrowserTabInfo } from '../../../../shared/runtime-types'
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

// Owns the runtime-side page this pane is bound to: creating or adopting it, reading its tab info,
// and the debounced post-input refresh. Split from the stream lifecycle so page identity stays
// testable on its own.
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
