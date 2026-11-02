import { randomUUID } from 'node:crypto'
import { createAgentStatusStore } from '../shared/agent-status-store'
import { isTmuxInnerSubject, type TmuxAgentHookOwner } from '../shared/tmux-agent-hook-owner'
import { readTmuxUnavailable, tmuxCanonicalStatusEvent } from '../shared/tmux-selected-status'
import type { AgentHookEventPayload } from '../shared/agent-hook-listener/listener-event'
import type { AgentHookSource } from '../shared/agent-hook-relay'
import { createRelayTmuxHookOwner } from './relay-tmux-hook-owner'
import { buildRelayHookEnvelope } from './agent-hook-envelope-build'
import type { RelayHookServerOptions } from './agent-hook-server-contract'

/** The hook server owns the authority; legacy ingress cannot write canonical pane subjects. */
export class RelayAgentHookCanonicalStatus {
  protected canonicalStatusStore = createAgentStatusStore({
    epoch: randomUUID(),
    mode: 'authority'
  })
  private tmuxOwner: TmuxAgentHookOwner | undefined
  private options: RelayHookServerOptions | undefined
  private getLegacyIdentity: (paneKey: string) => AgentHookEventPayload | undefined = () =>
    undefined
  private clearLegacyProjection: (paneKey: string) => void = () => {}

  protected configureCanonicalHooks(
    options: RelayHookServerOptions,
    clearLegacy: (paneKey: string) => void,
    getLegacyIdentity: (paneKey: string) => AgentHookEventPayload | undefined
  ): void {
    this.getLegacyIdentity = getLegacyIdentity
    this.options = options
    this.clearLegacyProjection = clearLegacy
  }

  protected startCanonicalHooks(): void {
    const options = this.options
    if (!options) {
      return
    }
    this.tmuxOwner ??= createRelayTmuxHookOwner({
      store: () => this.canonicalStatusStore,
      getRoot: options.getTmuxManagedPty,
      isRetired: options.isPaneSurfaceRetired ?? (() => false),
      publish: (event) => {
        this.clearLegacyProjection(event.paneKey)
        options.forward(buildRelayHookEnvelope(event, event.source ?? 'opencode', options.env))
      },
      takeLegacyIdentity: (paneKey) => {
        const prior = this.getLegacyIdentity(paneKey)
        this.clearLegacyProjection(paneKey)
        return prior
      },
      forwardUnavailable: options.forwardUnavailable
    })
  }

  protected ingestCanonicalTmuxHook(
    source: AgentHookSource,
    body: unknown,
    env: string
  ): Promise<boolean> {
    return this.tmuxOwner?.ingest(source, body, env) ?? Promise.resolve(false)
  }

  protected isCanonicalPane(paneKey: string): boolean {
    return this.canonicalStatusStore
      .getParents()
      .some((parent) => parent.subject.kind === 'pty' && parent.subject.paneKey === paneKey)
  }

  protected clearCanonicalPane(paneKey: string): void {
    this.tmuxOwner?.clearPane(paneKey)
    for (const parent of this.canonicalStatusStore.getParents()) {
      if (parent.subject.kind === 'pty' && parent.subject.paneKey === paneKey) {
        this.canonicalStatusStore.applyMutation({ removeParent: parent.subject })
      }
    }
  }

  protected replayCanonicalHooks(): number {
    const options = this.options
    if (!options) {
      return 0
    }
    let count = 0
    for (const parent of this.canonicalStatusStore.getParents()) {
      if (parent.subject.kind !== 'pty' || isTmuxInnerSubject(parent.subject)) {
        continue
      }
      if (options.isPaneSurfaceRetired?.(parent.subject.paneKey)) {
        this.clearCanonicalPane(parent.subject.paneKey)
        continue
      }
      const unavailable = readTmuxUnavailable(this.canonicalStatusStore, parent.subject)
      if (unavailable) {
        options.forwardUnavailable?.(unavailable)
      } else if (parent.status) {
        const event = tmuxCanonicalStatusEvent(parent.status)
        options.forward(
          buildRelayHookEnvelope(event, event.source ?? 'opencode', options.env, undefined, {
            isReplay: true
          })
        )
      } else {
        continue
      }
      count++
    }
    return count
  }

  protected stopCanonicalHooks(): void {
    this.tmuxOwner?.stop()
    this.tmuxOwner = undefined
    this.canonicalStatusStore = createAgentStatusStore({ epoch: randomUUID(), mode: 'authority' })
  }
}
