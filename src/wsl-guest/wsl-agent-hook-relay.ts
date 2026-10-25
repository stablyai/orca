#!/usr/bin/env node
// Forward guest loopback hooks over framed stdio and expose home-scoped installer operations (STA-1515).
// Exit with stdin: a lingering listener can let WSL forwarding capture the freed Windows port and blackhole hooks.
import { AGENT_HOOK_INFER_INTERRUPT_METHOD } from '../shared/agent-hook-interrupt-reconciliation'
import { homedir } from 'node:os'

import { RELAY_SENTINEL } from './protocol'
import { RelayDispatcher } from './dispatcher'
import { RelayAgentHookServer } from './agent-hook-server'
import { registerWslHookFsHandlers } from './wsl-hook-fs-bridge'
import { PluginOverlayManager } from './plugin-overlay'
import { createInstallPluginsHandler } from './wsl-install-plugins-handler'
import { PreflightHandler } from './preflight-handler'
import {
  AGENT_HOOK_INSTALL_PLUGINS_METHOD,
  AGENT_HOOK_REQUEST_REPLAY_METHOD
} from '../shared/agent-hook-relay'
import { publishAgentHookEnvelope } from './agent-hook-envelope-publication'
import {
  sanitizeWslHookInstanceKey,
  WSL_HOOK_RELAY_INSTANCE_ENV,
  wslHookRelayEndpointDir
} from '../shared/wsl-hook-relay-contract'

async function main(): Promise<void> {
  const windowsPort = Number(process.env.ORCA_AGENT_HOOK_PORT ?? '')
  const token = process.env.ORCA_AGENT_HOOK_TOKEN ?? ''
  if (!Number.isInteger(windowsPort) || windowsPort <= 0 || token.length === 0) {
    process.stderr.write('[wsl-hook-relay] missing ORCA_AGENT_HOOK_PORT/TOKEN in env\n')
    process.exit(1)
  }

  let stdoutAlive = true
  const dispatcher = new RelayDispatcher(
    (data, onSettled) => {
      if (!stdoutAlive) {
        onSettled({ ok: false, error: new Error('WSL relay stdout is closed') })
        return false
      }
      return process.stdout.write(data, (error) => {
        onSettled(error ? { ok: false, error } : { ok: true })
      })
    },
    {
      supportsWriteCallback: true,
      writableLength: () => process.stdout.writableLength,
      writableHighWaterMark: () => process.stdout.writableHighWaterMark,
      waitWriteDrain: (callback) => {
        process.stdout.once('drain', callback)
        return () => process.stdout.off('drain', callback)
      }
    }
  )

  // Keep endpoint-file identity across restarts so surviving agents can re-coordinate from its rewrite.
  const instanceKey =
    sanitizeWslHookInstanceKey(process.env[WSL_HOOK_RELAY_INSTANCE_ENV]) ?? `port${windowsPort}`
  const hookServer = new RelayAgentHookServer({
    endpointDir: wslHookRelayEndpointDir(homedir(), instanceKey),
    token,
    preferredPort: windowsPort,
    forward: (envelope) => publishAgentHookEnvelope(dispatcher, envelope)
  })
  dispatcher.onRequest(AGENT_HOOK_INFER_INTERRUPT_METHOD, async (params) => ({
    applied: hookServer.inferInterrupt(params)
  }))
  new PreflightHandler(dispatcher)

  dispatcher.onRequest(AGENT_HOOK_REQUEST_REPLAY_METHOD, async () => ({
    replayed: hookServer.replayCachedPayloadsForPanes()
  }))

  // Cache host-shipped plugin sources for the relay lifetime so repeat installs cannot rebuild beneath running agents.
  const installPlugins = createInstallPluginsHandler(new PluginOverlayManager(), process.env)
  dispatcher.onRequest(AGENT_HOOK_INSTALL_PLUGINS_METHOD, async (params) => installPlugins(params))

  registerWslHookFsHandlers(dispatcher, homedir(), () => ({
    portFallback: hookServer.usedPortFallback,
    boundPort: hookServer.getCoordinates().port
  }))

  try {
    await hookServer.start()
  } catch (err) {
    process.stderr.write(
      `[wsl-hook-relay] hook server bind failed: ${err instanceof Error ? err.message : String(err)}\n`
    )
    process.exit(1)
  }
  if (hookServer.usedPortFallback) {
    // Hook clients fail open silently; report the fallback expected under mirrored networking.
    process.stderr.write(
      `[wsl-hook-relay] port ${windowsPort} occupied; bound ${hookServer.getCoordinates().port} (endpoint-file re-coordination)\n`
    )
  }

  const shutdown = (): void => {
    stdoutAlive = false
    dispatcher.dispose()
    hookServer.stop()
    process.exit(0)
  }

  process.stdin.on('data', (chunk: Buffer) => dispatcher.feed(chunk))
  process.stdin.on('end', shutdown)
  process.stdin.on('error', shutdown)
  process.stdout.on('error', shutdown)
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
  // Exit on broken synchronous invariants so the host respawns; log and survive nonfatal async rejections.
  process.on('uncaughtException', (err) => {
    process.stderr.write(`[wsl-hook-relay] uncaught exception: ${err.message}\n`)
    process.exit(1)
  })
  process.on('unhandledRejection', (reason) => {
    process.stderr.write(`[wsl-hook-relay] unhandled rejection: ${String(reason)}\n`)
  })

  // The host waits for this exact sentinel before sending framed data.
  dispatcher.writePrimaryBytes(Buffer.from(RELAY_SENTINEL))
}

void main()
