import { z } from 'zod'

const Identity = z.string().min(1).max(256)

const BrowserNetworkNativeExecutionHost = z.object({
  kind: z.literal('native'),
  runtimeId: Identity,
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
})

const BrowserNetworkSshExecutionHost = z.object({
  kind: z.literal('ssh'),
  targetId: Identity,
  providerEpoch: Identity,
  connectionGeneration: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
})

const BrowserNetworkWslExecutionHost = z.object({
  kind: z.literal('wsl'),
  runtimeId: Identity,
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  distro: Identity
})

export const BrowserNetworkExecutionHost = z.discriminatedUnion('kind', [
  BrowserNetworkNativeExecutionHost,
  BrowserNetworkSshExecutionHost,
  BrowserNetworkWslExecutionHost
])

export type BrowserNetworkExecutionHost = z.infer<typeof BrowserNetworkExecutionHost>

export function browserNetworkExecutionHostKey(host: BrowserNetworkExecutionHost): string {
  if (host.kind === 'native') {
    return JSON.stringify(['native', host.runtimeId, host.revision])
  }
  if (host.kind === 'wsl') {
    return JSON.stringify(['wsl', host.runtimeId, host.revision, host.distro])
  }
  return JSON.stringify(['ssh', host.targetId, host.providerEpoch, host.connectionGeneration])
}

export function parseBrowserNetworkExecutionHostKey(key: string): BrowserNetworkExecutionHost {
  let tuple: unknown
  try {
    tuple = JSON.parse(key)
  } catch {
    throw new Error('browser_tunnel_execution_host_key_invalid')
  }
  const candidate =
    Array.isArray(tuple) && tuple[0] === 'native' && tuple.length === 3
      ? { kind: 'native', runtimeId: tuple[1], revision: tuple[2] }
      : Array.isArray(tuple) && tuple[0] === 'wsl' && tuple.length === 4
        ? { kind: 'wsl', runtimeId: tuple[1], revision: tuple[2], distro: tuple[3] }
        : Array.isArray(tuple) && tuple[0] === 'ssh' && tuple.length === 4
          ? {
              kind: 'ssh',
              targetId: tuple[1],
              providerEpoch: tuple[2],
              connectionGeneration: tuple[3]
            }
          : null
  const parsed = BrowserNetworkExecutionHost.safeParse(candidate)
  if (!parsed.success || browserNetworkExecutionHostKey(parsed.data) !== key) {
    throw new Error('browser_tunnel_execution_host_key_invalid')
  }
  return parsed.data
}
