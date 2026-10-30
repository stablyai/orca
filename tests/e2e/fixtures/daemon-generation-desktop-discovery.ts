import { DaemonPtyAdapter } from '../../../src/main/daemon/daemon-pty-adapter'
import { createLegacyDaemonAdapters } from '../../../src/main/daemon/daemon-legacy-adapters'
import { DaemonPtyRouter } from '../../../src/main/daemon/daemon-pty-router'

export type DesktopDiscoveryGeneration = {
  protocolVersion: number
  socketPath: string
  tokenPath: string
}

export async function createDesktopDiscoveredDaemonRouter(options: {
  generations: readonly DesktopDiscoveryGeneration[]
  currentProtocolVersion: number
  daemonDir: string
  historyDir: string
}): Promise<{ router: DaemonPtyRouter; adapters: readonly DaemonPtyAdapter[] }> {
  const currentGeneration = options.generations.find(
    (generation) => generation.protocolVersion === options.currentProtocolVersion
  )
  if (!currentGeneration) {
    throw new Error(`Missing current protocol v${options.currentProtocolVersion} fixture`)
  }
  const current = new DaemonPtyAdapter({
    socketPath: currentGeneration.socketPath,
    tokenPath: currentGeneration.tokenPath,
    protocolVersion: currentGeneration.protocolVersion,
    historyPath: options.historyDir
  })
  // Exercise the production startup scanner’s versioned-pipe discovery and legacy-adapter construction.
  const legacy = await createLegacyDaemonAdapters(options.daemonDir, options.historyDir)
  const discoveredProtocols = legacy.map((adapter) => adapter.protocolVersion)
  const expectedProtocols = options.generations
    .filter((generation) => generation.protocolVersion !== options.currentProtocolVersion)
    .map((generation) => generation.protocolVersion)
  if (JSON.stringify(discoveredProtocols) !== JSON.stringify(expectedProtocols)) {
    throw new Error(
      `Desktop legacy discovery mismatch: expected ${expectedProtocols.join(',')}, received ${discoveredProtocols.join(',')}`
    )
  }
  return {
    router: new DaemonPtyRouter({ current, legacy }),
    adapters: [current, ...legacy]
  }
}
