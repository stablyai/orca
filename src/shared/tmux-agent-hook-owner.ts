import { normalizeHookPayload } from './agent-hook-listener'
import {
  createHookListenerState,
  type HookListenerState
} from './agent-hook-listener/listener-state'
import type { AgentHookEventPayload } from './agent-hook-listener/listener-event'
import type { AgentHookSource } from './agent-hook-relay'
import type { AgentStatusStore } from './agent-status-store'
import { continueMainAgentStatus } from './agent-lead-status-fold'
import { tmuxCanonicalStatusEvent, tmuxInnerSubject } from './tmux-selected-status'
import type { AgentStatusExecutionScope, AgentStatusPtySubject } from './agent-status-subject'
import {
  readTmuxHookPane,
  resolveTmuxClientAttachment,
  type TmuxHookPane
} from './tmux-client-attachment'
import { probeTmuxHostAttachments } from './tmux-host-attachment-probe'
export { isTmuxInnerSubject } from './tmux-selected-status'

export type TmuxManagedPty = {
  pid: number
  incarnation: string
  scope: AgentStatusExecutionScope
}
type OuterPane = {
  paneKey: string
  socket: string
  root: TmuxManagedPty
  inner: Map<string, { subject: AgentStatusPtySubject; normalization: HookListenerState }>
  selection?: string
  publication?: string
}
/** Inner observations live in the hook owner's canonical store; this index holds attachments only. */
export class TmuxAgentHookOwner {
  private readonly outers = new Map<string, OuterPane>()
  private timer: ReturnType<typeof setInterval> | undefined
  private refreshing: Promise<void> | undefined
  private stopped = false
  private lastRefreshAt = -Infinity
  private socketCursor = 0

  constructor(
    private readonly options: {
      store: () => AgentStatusStore
      getRoot: (paneKey: string) => Promise<TmuxManagedPty | null>
      publish: (
        event: AgentHookEventPayload,
        observedAt: number,
        subject: AgentStatusPtySubject,
        stateStartedAt: number
      ) => void
      unavailable: (
        paneKey: string,
        subject?: AgentStatusPtySubject,
        identity?: AgentHookEventPayload
      ) => void
      probe?: typeof probeTmuxHostAttachments
      isRetired?: (paneKey: string) => boolean
      now?: () => number
    }
  ) {}

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  async ingest(source: AgentHookSource, body: unknown, env: string): Promise<boolean> {
    if (source !== 'opencode' && source !== 'opencode2') {
      return false
    }
    if (typeof body !== 'object' || body === null || !('tmux' in body)) {
      return false
    }
    const tmux = readTmuxHookPane(body.tmux)
    if (!tmux || !('paneKey' in body) || typeof body.paneKey !== 'string' || this.stopped) {
      return true
    }
    const paneKey = body.paneKey
    const root = await this.options.getRoot(paneKey).catch(() => null)
    if (
      !root ||
      this.stopped ||
      this.options.isRetired?.(paneKey) ||
      !('worktreeId' in body) ||
      body.worktreeId !== root.scope.workspaceId
    ) {
      return true
    }
    let outer = this.outers.get(paneKey)
    if (
      outer &&
      (outer.root.incarnation !== root.incarnation ||
        outer.root.pid !== root.pid ||
        outer.socket !== tmux.socket)
    ) {
      this.clearPane(paneKey)
      outer = undefined
    }
    if (!outer) {
      if (this.outers.size >= 64) {
        return true
      }
      outer = { paneKey, socket: tmux.socket, root, inner: new Map() }
      this.outers.set(paneKey, outer)
    }
    const inner = this.inner(outer, tmux)
    if (!inner) {
      return true
    }
    const store = this.options.store()
    const previousParent = store.getParent(inner.subject)
    const previous = previousParent?.status
    const event = normalizeHookPayload(inner.normalization, source, body, env, {
      previousOpenCodeMainAgent: previous?.mainAgent
    })
    if (!event || event.paneKey !== paneKey) {
      return true
    }
    const observedAt = this.now()
    const stateStartedAt =
      previous?.state === event.payload.state && previous.workingMode === event.payload.workingMode
        ? previous.stateStartedAt
        : observedAt
    store.applyMutation({
      parent: {
        subject: inner.subject,
        firstObservedAt: previousParent?.firstObservedAt ?? observedAt,
        status: {
          ...event.payload,
          ...(event.payload.mainAgent
            ? {
                mainAgent: continueMainAgentStatus(
                  previous?.mainAgent,
                  event.payload.mainAgent,
                  observedAt
                )
              }
            : {}),
          paneKey: inner.subject.paneKey,
          tabId: event.tabId,
          worktreeId: root.scope.workspaceId,
          connectionId: null,
          receivedAt: observedAt,
          evidenceObservedAt: observedAt,
          stateStartedAt,
          providerSession: event.providerSession,
          promptInteractionKey: event.promptInteractionKey,
          launchToken: event.launchToken
        }
      }
    })
    if (!this.timer) {
      this.timer = setInterval(() => {
        void this.refresh()
      }, 1000)
      this.timer.unref?.()
    }
    this.project(outer)
    await this.refresh()
    return true
  }

  private inner(outer: OuterPane, tmux: TmuxHookPane) {
    let inner = outer.inner.get(tmux.pane)
    if (!inner && outer.inner.size < 32) {
      const subject = tmuxInnerSubject(outer.root.scope, outer.paneKey, tmux)
      inner = { subject, normalization: createHookListenerState() }
      outer.inner.set(tmux.pane, inner)
    }
    return inner
  }

  refresh(): Promise<void> {
    if (this.refreshing) {
      return this.refreshing
    }
    if (this.stopped || this.now() - this.lastRefreshAt < 1000) {
      return Promise.resolve()
    }
    this.lastRefreshAt = this.now()
    const work = this.refreshAttachments().finally(() => {
      if (this.refreshing === work) {
        this.refreshing = undefined
      }
    })
    this.refreshing = work
    return work
  }

  private async refreshAttachments(): Promise<void> {
    const groups = new Map<string, OuterPane[]>()
    for (const outer of this.outers.values()) {
      const group = groups.get(outer.socket) ?? []
      group.push(outer)
      groups.set(outer.socket, group)
    }
    const entries = [...groups]
    const start = this.socketCursor % Math.max(entries.length, 1)
    const selected = entries.slice(start).concat(entries.slice(0, start)).slice(0, 16)
    this.socketCursor = (start + selected.length) % Math.max(entries.length, 1)
    for (let index = 0; index < selected.length; index += 2) {
      await Promise.all(
        selected.slice(index, index + 2).map(async ([socket, outers]) => {
          const proof = await (this.options.probe ?? probeTmuxHostAttachments)(
            socket,
            outers.map((outer) => outer.root.pid)
          ).catch(() => null)
          if (!proof || this.stopped) {
            return
          }
          for (const outer of outers) {
            if (this.outers.get(outer.paneKey) !== outer) {
              continue
            }
            const current = await this.options.getRoot(outer.paneKey).catch(() => null)
            if (this.stopped || this.outers.get(outer.paneKey) !== outer) {
              continue
            }
            if (this.options.isRetired?.(outer.paneKey)) {
              this.clearPane(outer.paneKey)
              continue
            }
            if (!current) {
              continue
            }
            if (current.incarnation !== outer.root.incarnation || current.pid !== outer.root.pid) {
              this.unavailable(outer)
              this.clearPane(outer.paneKey)
              continue
            }
            const client = resolveTmuxClientAttachment(outer.root.pid, proof.clients, proof.rows)
            if (!client) {
              outer.selection = undefined
              if (outer.publication !== 'unattached') {
                outer.publication = 'unattached'
                this.unavailable(outer)
              }
              continue
            }
            outer.selection = client.pane
            this.project(outer)
          }
        })
      )
    }
  }

  private unavailable(outer: OuterPane): void {
    const status = [...outer.inner.values()]
      .map(({ subject }) => this.options.store().getParent(subject)?.status)
      .find(Boolean)
    this.options.unavailable(
      outer.paneKey,
      { ...outer.root.scope, kind: 'pty', paneKey: outer.paneKey },
      status ? tmuxCanonicalStatusEvent(status) : undefined
    )
  }

  private project(outer: OuterPane): void {
    if (!outer.selection || this.outers.get(outer.paneKey) !== outer) {
      return
    }
    const inner = outer.inner.get(outer.selection)
    const parent = inner && this.options.store().getParent(inner.subject)
    const status = parent?.status
    const key = `${outer.selection}:${parent?.revision ?? 'unavailable'}`
    if (outer.publication === key) {
      return
    }
    outer.publication = key
    if (!status) {
      this.unavailable(outer)
      return
    }
    this.options.publish(
      { ...tmuxCanonicalStatusEvent(status), paneKey: outer.paneKey },
      status.evidenceObservedAt ?? status.receivedAt,
      { ...outer.root.scope, kind: 'pty', paneKey: outer.paneKey },
      status.stateStartedAt
    )
  }

  clearPane(paneKey: string): void {
    const outer = this.outers.get(paneKey)
    if (!outer) {
      return
    }
    this.outers.delete(paneKey)
    for (const { subject } of outer.inner.values()) {
      this.options.store().applyMutation({ removeParent: subject })
    }
    if (this.outers.size === 0) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  clearTab(tabId: string): void {
    for (const paneKey of this.outers.keys()) {
      if (paneKey.startsWith(`${tabId}:`)) {
        this.clearPane(paneKey)
      }
    }
  }

  stop(): void {
    this.stopped = true
    for (const paneKey of this.outers.keys()) {
      this.clearPane(paneKey)
    }
  }
}
