export type RemoteBrowserViewportSize = {
  width: number
  height: number
}

// Why: sub-pixel jitter from the resize observer must not count as a resize, or every layout
// settle would tear down a healthy stream.
export function areRemoteViewportSizesNear(
  a: RemoteBrowserViewportSize | null,
  b: RemoteBrowserViewportSize | null
): boolean {
  if (!a || !b) {
    return false
  }
  return Math.abs(a.width - b.width) <= 3 && Math.abs(a.height - b.height) <= 3
}

export type RemoteBrowserStreamToken = {
  tabId: string
  environmentId: string
  remotePageId: string
  generation: number
  operationGeneration: number
}

export type RemoteBrowserStreamSubscription = {
  token: RemoteBrowserStreamToken
  unsubscribe: () => void
}

export type RemoteBrowserOperationToken = {
  tabId: string
  environmentId: string
  remotePageId: string | null
  generation: number
}

// Why: pane identity lives in React refs; the lifecycle reads it through this port so the same
// staleness guards can run in a test with no component mounted.
export type RemoteBrowserPaneIdentity = {
  isMounted(): boolean
  isActive(): boolean
  getTabId(): string
  getEnvironmentId(): string | null
  browserPageExists(tabId: string): boolean
}

// Owns the two generation counters every async remote-browser operation is guarded by: the
// operation generation (a new pane/page/environment epoch) and the stream generation (one
// screencast subscription). Anything that supersedes work bumps one of them.
export class RemoteBrowserOperationTokens {
  private operationGeneration = 0
  private streamGeneration = 0
  private activeStreamToken: RemoteBrowserStreamToken | null = null
  private remotePageId: string | null = null

  constructor(private readonly identity: RemoteBrowserPaneIdentity) {}

  get remotePage(): string | null {
    return this.remotePageId
  }

  setRemotePage(remotePageId: string | null): void {
    this.remotePageId = remotePageId
  }

  createOperationToken(remotePageId: string | null = null): RemoteBrowserOperationToken | null {
    const environmentId = this.identity.getEnvironmentId()
    if (!environmentId) {
      return null
    }
    return {
      tabId: this.identity.getTabId(),
      environmentId,
      remotePageId,
      generation: this.operationGeneration
    }
  }

  isCurrent(token: RemoteBrowserOperationToken): boolean {
    return (
      this.identity.isMounted() &&
      this.identity.isActive() &&
      this.identity.browserPageExists(token.tabId) &&
      this.identity.getTabId() === token.tabId &&
      this.identity.getEnvironmentId() === token.environmentId &&
      this.operationGeneration === token.generation &&
      (token.remotePageId === null || this.remotePageId === token.remotePageId)
    )
  }

  isCurrentStreamOperation(token: RemoteBrowserStreamToken): boolean {
    return this.isCurrent(toOperationToken(token))
  }

  isCurrentStreamToken(token: RemoteBrowserStreamToken): boolean {
    const active = this.activeStreamToken
    return (
      active?.generation === token.generation &&
      active.operationGeneration === token.operationGeneration &&
      active.tabId === token.tabId &&
      active.environmentId === token.environmentId &&
      active.remotePageId === token.remotePageId &&
      this.isCurrentStreamOperation(token)
    )
  }

  // Why: every supersession site bumps the operation generation so in-flight awaits fail their own
  // token guard on resume — clearing a timer cannot recall work already dispatched into an await.
  supersedeOperations(): void {
    this.operationGeneration += 1
  }

  supersedeStream(): void {
    this.streamGeneration += 1
  }

  claimStreamToken(
    operationToken: RemoteBrowserOperationToken,
    remotePageId: string
  ): RemoteBrowserStreamToken {
    const token: RemoteBrowserStreamToken = {
      tabId: this.identity.getTabId(),
      environmentId: operationToken.environmentId,
      remotePageId,
      generation: this.streamGeneration + 1,
      operationGeneration: operationToken.generation
    }
    this.streamGeneration = token.generation
    this.activeStreamToken = token
    return token
  }

  releaseStreamToken(): void {
    this.activeStreamToken = null
  }
}

export function toOperationToken(token: RemoteBrowserStreamToken): RemoteBrowserOperationToken {
  return {
    tabId: token.tabId,
    environmentId: token.environmentId,
    remotePageId: token.remotePageId,
    generation: token.operationGeneration
  }
}
