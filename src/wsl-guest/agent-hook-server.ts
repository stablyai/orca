import { AgentHookStartup } from '../shared/agent-hook-startup'
import { bindRelayHookServer } from './agent-hook-server-bind'
import {
  inferRelayClaudeInterrupt,
  type RelayInterruptHost
} from './agent-hook-interrupt-reconciliation'
import { applyRelayHookEvent } from './agent-hook-event-admission'
import { RelayProviderHookNormalization } from './agent-hook-provider-normalization'
import { RelayAgentHookCanonicalStatus } from './agent-hook-canonical-status'
import type {
  RelayHookForward,
  RelayHookServerOptions,
  RelayHookServerStartOptions
} from './agent-hook-server-contract'
import { handleRelayHookRequest } from './agent-hook-request'
import { RelayAgentPresence } from './relay-agent-presence'
import type { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

import {
  ORCA_HOOK_PROTOCOL_VERSION,
  ORCA_HOOK_RAW_JSON_TRANSPORT
} from '../shared/agent-hook-types'
import {
  clearAllListenerCaches,
  clearPaneCacheState,
  createHookListenerState
} from '../shared/agent-hook-listener/listener-state'
import {
  getEndpointFileName,
  writeEndpointFile
} from '../shared/agent-hook-listener/endpoint-publication'
import type { AgentHookEventPayload } from '../shared/agent-hook-listener/listener-event'
import {
  createHookTransportInterferenceTracker,
  describeHookTransportInterference
} from '../shared/agent-hook-transport-interference'
import { REMOTE_AGENT_HOOK_ENV, type AgentHookSource } from '../shared/agent-hook-relay'
import type { SpoolRecord } from '../shared/agent-hook-spool'
import { buildRelayHookPtyEnv, defaultEndpointDir } from './agent-hook-endpoint-coordinates'
import { drainRelayHookSpool, ingestRelayHookSpoolRecord } from './agent-hook-spool-ingest'
import { AgentHookResultRetryScheduler } from './agent-hook-result-retry-scheduler'
import {
  buildCachedPaneReplayEnvelope,
  selectReplayableCachedPanes,
  type CachedPaneEnvelopeMeta
} from './agent-hook-cached-pane-status'
import { createRelayClaudeTerminalInterrupts } from './claude-terminal-interrupt-status'

export class RelayAgentHookServer extends RelayAgentHookCanonicalStatus {
  private server: ReturnType<typeof createServer> | null = null
  private readonly startup = new AgentHookStartup()
  private port = 0
  private token = ''
  private env: string
  private endpointDir: string
  private endpointFilePath: string
  private endpointFileWritten = false
  private state = createHookListenerState()
  private readonly providerNormalization = new RelayProviderHookNormalization()
  private transportInterference = createHookTransportInterferenceTracker((report) => {
    process.stderr.write(`${describeHookTransportInterference(report)}\n`)
  })
  // Why: retain envelope metadata so replays match live POSTs.
  // Invariant: keys mirror state.lastStatusByPaneKey, populated/cleared in lockstep.
  private lastEnvelopeMetaByPaneKey = new Map<string, CachedPaneEnvelopeMeta>()
  private forward: RelayHookForward
  private isPaneSurfaceRetired: (paneKey: string) => boolean
  private getAgentLaunchToken: (paneKey: string) => string | undefined
  private fixedToken: string | undefined
  private preferredPort: number
  private portFallbackApplied = false
  private readonly presenceChecks = new RelayAgentPresence()
  private retryScheduler: AgentHookResultRetryScheduler
  readonly claudeTerminalInterrupts = createRelayClaudeTerminalInterrupts(this.state, () =>
    this.relayInterruptHost()
  )

  constructor(options: RelayHookServerOptions) {
    super()
    this.env = options.env ?? REMOTE_AGENT_HOOK_ENV
    this.endpointDir = options.endpointDir ?? defaultEndpointDir()
    this.endpointFilePath = join(this.endpointDir, getEndpointFileName())
    this.fixedToken = options.token
    this.preferredPort = options.preferredPort ?? 0
    this.forward = options.forward
    this.isPaneSurfaceRetired = options.isPaneSurfaceRetired ?? (() => false)
    this.getAgentLaunchToken = options.getAgentLaunchToken ?? (() => undefined)
    this.configureCanonicalHooks(
      options,
      (paneKey) => this.clearPaneState(paneKey, true),
      (paneKey) => {
        const row = this.state.lastStatusByPaneKey.get(paneKey)
        return row
          ? { ...row, source: this.lastEnvelopeMetaByPaneKey.get(paneKey)?.source ?? row.source }
          : undefined
      }
    )
    this.retryScheduler = new AgentHookResultRetryScheduler({
      state: this.state,
      env: this.env,
      isListening: () => this.server !== null,
      applyEvent: (event, source, env, version) =>
        this.applyEvent(event, source, env, version, { checkPresence: false })
    })
  }

  start(options: RelayHookServerStartOptions = {}): Promise<void> {
    return this.startup.start((isCurrent) => this.startListener(options, isCurrent))
  }

  private async startListener(
    options: RelayHookServerStartOptions,
    isCurrent: () => boolean
  ): Promise<void> {
    if (this.server) {
      return
    }
    this.startCanonicalHooks()
    this.token = this.fixedToken ?? randomUUID()
    this.endpointFileWritten = false
    this.portFallbackApplied = false
    await drainRelayHookSpool(this.endpointDir, (record) =>
      this.ingestSpoolRecord(record, isCurrent)
    )
    if (!isCurrent()) {
      return
    }
    await bindRelayHookServer({
      preferredPort: this.preferredPort,
      isCurrent,
      handleRequest: (req, res) =>
        handleRelayHookRequest(req, res, {
          isCurrent,
          token: this.token,
          env: this.env,
          state: this.state,
          providerNormalization: this.providerNormalization,
          checkAgentPresence: (paneKey) => this.checkAgentPresence(paneKey),
          isPaneSurfaceRetired: this.isPaneSurfaceRetired,
          getAgentLaunchToken: this.getAgentLaunchToken,
          applyEvent: (event, source, env, version) => this.applyEvent(event, source, env, version),
          ingestTmuxHook: (source, body) => this.ingestCanonicalTmuxHook(source, body, this.env),
          retryScheduler: this.retryScheduler,
          transportInterference: this.transportInterference
        }),
      setServer: (server) => {
        this.server = server
      },
      setPort: (port) => {
        this.port = port
      },
      onFallback: () => {
        this.portFallbackApplied = true
      }
    })
    if (isCurrent() && options.publishEndpoint !== false) {
      this.publishEndpointFile()
    }
  }

  get usedPortFallback(): boolean {
    return this.portFallbackApplied
  }

  publishEndpointFile(): boolean {
    if (this.port <= 0 || !this.token) {
      this.endpointFileWritten = false
      return false
    }
    this.endpointFileWritten = writeEndpointFile(this.endpointDir, this.endpointFilePath, {
      port: this.port,
      token: this.token,
      env: this.env,
      version: ORCA_HOOK_PROTOCOL_VERSION,
      openCodeTui: true,
      transport: ORCA_HOOK_RAW_JSON_TRANSPORT
    })
    return this.endpointFileWritten
  }

  stop(): void {
    this.startup.stop()
    this.server?.close()
    this.server = null
    this.port = 0
    this.token = ''
    this.endpointFileWritten = false
    this.stopCanonicalHooks()
    this.retryScheduler.clearAll()
    clearAllListenerCaches(this.state)
    this.providerNormalization.clear()
    this.claudeTerminalInterrupts.clear()
    this.lastEnvelopeMetaByPaneKey.clear()
  }

  /** Request-driven replay: re-forwards each cached paneKey payload as a fresh notification. Forwards are
   *  issued before the request handler returns, so the response trails all replayed notifications. */
  replayCachedPayloadsForPanes(): number {
    const cachedSnapshot = new Map(this.state.lastStatusByPaneKey)
    const replayable = selectReplayableCachedPanes({
      cachedByPaneKey: cachedSnapshot,
      metaByPaneKey: this.lastEnvelopeMetaByPaneKey,
      isPaneSurfaceRetired: this.isPaneSurfaceRetired,
      dropPane: (paneKey) => this.clearPaneState(paneKey)
    })
    for (const { event, meta } of replayable) {
      void this.checkAgentPresence(event.paneKey)
      this.forward(buildCachedPaneReplayEnvelope({ event, meta }))
    }
    return replayable.length + this.replayCanonicalHooks()
  }

  inferInterrupt(request: unknown): boolean {
    return inferRelayClaudeInterrupt(this.relayInterruptHost(), request)
  }

  private relayInterruptHost(): RelayInterruptHost {
    return {
      state: this.state,
      isListening: this.server !== null,
      getMetadata: (paneKey) => this.lastEnvelopeMetaByPaneKey.get(paneKey),
      getAgentLaunchToken: this.getAgentLaunchToken,
      isPaneBlocked: (paneKey) =>
        this.isCanonicalPane(paneKey) || this.isPaneSurfaceRetired(paneKey),
      apply: (event, meta) =>
        this.applyEvent(event, meta.source, meta.env, meta.version, { checkPresence: false }),
      armExpiry: (paneKey, meta) =>
        this.retryScheduler.armClaudeOwedNotificationExpiry(
          meta.source,
          paneKey,
          meta.env,
          meta.version
        )
    }
  }

  checkAgentPresence(paneKey: string): Promise<void> {
    const row = this.state.lastStatusByPaneKey.get(paneKey)
    const meta = this.lastEnvelopeMetaByPaneKey.get(paneKey)
    return this.presenceChecks.check(
      row,
      () => this.state.lastStatusByPaneKey.get(paneKey),
      (event) => {
        if (meta) {
          this.applyEvent(event, meta.source, meta.env, meta.version)
        }
      }
    )
  }

  /** Drop a paneKey's cached entries on PTY exit so a terminated pane can't resurface as a ghost event on reconnect. */
  clearPaneState(paneKey: string, preserveTmuxInnerSubjects = false): void {
    this.claudeTerminalInterrupts.observe(paneKey, { kind: 'reset' })
    if (!preserveTmuxInnerSubjects) {
      this.clearCanonicalPane(paneKey)
    }
    this.retryScheduler.clearAssistantMessageRetry(paneKey)
    this.retryScheduler.clearTranscriptPoll(paneKey)
    clearPaneCacheState(this.state, paneKey)
    this.providerNormalization.clearPane(paneKey)
    this.lastEnvelopeMetaByPaneKey.delete(paneKey)
  }

  /** Env vars to inject into relay-spawned PTYs so the hook script/plugin POSTs back to this loopback server. */
  buildPtyEnv(): Record<string, string> {
    return buildRelayHookPtyEnv({
      port: this.port,
      token: this.token,
      env: this.env,
      endpointFilePath: this.endpointFilePath,
      endpointFileWritten: this.endpointFileWritten
    })
  }

  /** Test-only / diagnostics accessor. */
  getCoordinates(): { port: number; token: string; endpointFilePath: string } {
    return { port: this.port, token: this.token, endpointFilePath: this.endpointFilePath }
  }

  // ─── Private ──────────────────────────────────────────────────────

  private applyEvent(
    incoming: AgentHookEventPayload,
    source: AgentHookSource,
    env?: string,
    version?: string,
    options: { isReplay?: boolean; checkPresence?: boolean } = {}
  ): AgentHookEventPayload | undefined {
    return applyRelayHookEvent(
      {
        state: this.state,
        metadata: this.lastEnvelopeMetaByPaneKey,
        isCanonicalPane: (paneKey) => this.isCanonicalPane(paneKey),
        isPaneSurfaceRetired: this.isPaneSurfaceRetired,
        clearPaneState: (paneKey) => this.clearPaneState(paneKey),
        clearAssistantMessageRetry: (paneKey) =>
          this.retryScheduler.clearAssistantMessageRetry(paneKey),
        forward: this.forward,
        checkAgentPresence: (paneKey) => this.checkAgentPresence(paneKey)
      },
      incoming,
      source,
      env,
      version,
      options
    )
  }

  private ingestSpoolRecord(record: SpoolRecord, isCurrent: () => boolean): Promise<void> | void {
    return ingestRelayHookSpoolRecord(record, this.state, this.env, {
      providerNormalization: this.providerNormalization,
      checkAgentPresence: (paneKey) => this.checkAgentPresence(paneKey),
      isCurrent,
      apply: (...args) => this.applyEvent(...args, { isReplay: true }),
      isPaneSurfaceRetired: this.isPaneSurfaceRetired,
      getAgentLaunchToken: this.getAgentLaunchToken
    })
  }
}
