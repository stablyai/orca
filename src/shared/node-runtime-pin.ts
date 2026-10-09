/**
 * The one Node runtime Orca runs outside Electron (docs/reference/node-runtime-design.html, D1).
 *
 * Keep this file erasable-only TypeScript — build scripts import it directly under Node's
 * type stripping, which rejects enums, namespaces and parameter properties.
 */

export const SERVER_TARGETS = [
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64-glibc',
  'linux-x64-glibc',
  'linux-arm64-musl',
  'linux-x64-musl',
  'win32-arm64',
  'win32-x64'
] as const

export type ServerTarget = (typeof SERVER_TARGETS)[number]

// Opt-in runtimes outside the default set: the unofficial glibc 2.17 x64 build (design D6 rung B).
export const COMPAT_SERVER_TARGETS = ['linux-x64-glibc217'] as const

export type CompatServerTarget = (typeof COMPAT_SERVER_TARGETS)[number]

export type NodeRuntimeTarget = ServerTarget | CompatServerTarget

/** The default target a compat runtime stands in for: same host, older glibc. */
export const COMPAT_SERVER_TARGET_BASES: Record<CompatServerTarget, ServerTarget> = {
  'linux-x64-glibc217': 'linux-x64-glibc'
}

// Every target: Windows SSH relays take their node-pty/ConPTY slot from here (design D5), even
// though managed orcad launch stays POSIX-only (orcad-remote-host-support.ts).
export const ORCAD_TEMPLATE_TARGETS: readonly ServerTarget[] = SERVER_TARGETS

export type NodeRuntimePin = {
  version: string
  /** Electron whose embedded Node this pin tracks; the older/newer policy is open (design D1). */
  electron: string
  /** Highest N-API version the runtime supports (NODE_API_SUPPORTED_VERSION_MAX). */
  napi: number
  headers: { file: string; sha256: string }
  /** node.lib per Windows target: node-gyp --nodedir links against it, and the headers tarball omits it. */
  windowsImportLibs: Record<WindowsServerTarget, { file: string; sha256: string }>
}

export type WindowsServerTarget = Extract<ServerTarget, `win32-${string}`>

/** unofficial-builds.nodejs.org publishes no SHASUMS signature, so its hash is trusted at pin time. */
export type NodeRuntimeAssetSource = 'official' | 'unofficial'

export type NodeRuntimeAsset = {
  source: NodeRuntimeAssetSource
  archive: string
  archiveSha256: string
  executableSha256: string
  executableSize: number
}

// @generated-begin by config/scripts/update-node-runtime-pin.mjs
export const NODE_RUNTIME_PIN: NodeRuntimePin = {
  version: '24.21.0',
  electron: '43.7.5',
  napi: 10,
  headers: {
    file: 'node-v24.21.0-headers.tar.gz',
    sha256: '57c6bee2e30bbbee5bd51d6cc343eb992e174b56a2a1d0eab7a7510771c20ea2'
  },
  windowsImportLibs: {
    'win32-arm64': {
      file: 'win-arm64/node.lib',
      sha256: '2c0c3215d59c09d7c136da4949696dae121a299e9bdfc64cd9130a58610af63d'
    },
    'win32-x64': {
      file: 'win-x64/node.lib',
      sha256: 'a0a84aa03917b578d286010b7521837e9ff1136ffb2e4a406c14316c33fd06f7'
    }
  }
}

export const NODE_RUNTIME_ASSETS: Record<ServerTarget, NodeRuntimeAsset> = {
  'darwin-arm64': {
    source: 'official',
    archive: 'node-v24.21.0-darwin-arm64.tar.gz',
    archiveSha256: 'bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057',
    executableSha256: 'e4b5a3af0e05c75de2eae013904145f40fe7fc2a6e6f17510128bf45cca4e79b',
    executableSize: 122129232
  },
  'darwin-x64': {
    source: 'official',
    archive: 'node-v24.21.0-darwin-x64.tar.gz',
    archiveSha256: '1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097',
    executableSha256: '7abcf39bd37ab251015337ff75304d7555f0d8e88c6e0fbf04bce8ce34636f49',
    executableSize: 125270960
  },
  'linux-arm64-glibc': {
    source: 'official',
    archive: 'node-v24.21.0-linux-arm64.tar.gz',
    archiveSha256: '724282c3b43aec998aa9527380465b45d229e021b58035f5f4f63095eabfe5d5',
    executableSha256: '0f8949d1028f6d61506b2d5bc57e7e6fe893d7b1997509b7847294fc9c616584',
    executableSize: 122893672
  },
  'linux-x64-glibc': {
    source: 'official',
    archive: 'node-v24.21.0-linux-x64.tar.gz',
    archiveSha256: '6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff',
    executableSha256: '7fde7b8afa198da66257f42ee2001d874c7355631e6d1579a5fb5ef1f246df4c',
    executableSize: 126595440
  },
  'linux-arm64-musl': {
    source: 'unofficial',
    archive: 'node-v24.21.0-linux-arm64-musl.tar.gz',
    archiveSha256: '3048b0811e158ca0d8672b59c839861763e144492980d8d29b369dfee45747e4',
    executableSha256: 'fa2789559dbc3603794a229877c244d1c0d06625c124631611ca4e13eac765be',
    executableSize: 128653768
  },
  'linux-x64-musl': {
    source: 'official',
    archive: 'node-v24.21.0-linux-x64-musl.tar.gz',
    archiveSha256: '3d63405fc65a0d2d2976c1f0bc2fd27bb0bd07212469e705aac3f03ae5ab4c9c',
    executableSha256: '2cd83acecc7693ce96bcb4e292ff4c80461b7490028a002abe5a28ac9892bc29',
    executableSize: 132204408
  },
  'win32-arm64': {
    source: 'official',
    archive: 'node-v24.21.0-win-arm64.zip',
    archiveSha256: '8779b1bde1d39f8d420e3b57aa657b39891af434d3de44a919044cec06785921',
    executableSha256: 'dff59da18b6ffe1bf1ca99e1d2af4906080c481740619f5b5098c0fca28bd9b7',
    executableSize: 81881416
  },
  'win32-x64': {
    source: 'official',
    archive: 'node-v24.21.0-win-x64.zip',
    archiveSha256: '158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541',
    executableSha256: 'ba4e6d110e8c1592a1ecd390f6b05f3da124b13871a5be62b341a07a853c6c32',
    executableSize: 93580104
  }
}

export const NODE_RUNTIME_COMPAT_ASSETS: Record<CompatServerTarget, NodeRuntimeAsset> = {
  'linux-x64-glibc217': {
    source: 'unofficial',
    archive: 'node-v24.21.0-linux-x64-glibc-217.tar.gz',
    archiveSha256: 'b1d164136d4b218d663e664f40ba5e260ebc07f90e2bd784c63a57d8c0e6aa8a',
    executableSha256: '1e75c95b1af4ec41e83d75816856b205f00c9427fd7d2dadd81472b38ff53d2c',
    executableSize: 139511096
  }
}
// @generated-end

/**
 * The pinned darwin Node's `LC_BUILD_VERSION minos`, and so the floor of the macOS terminal host.
 * Packaging fails when a pin bump changes it; below it the desktop forks the daemon instead.
 */
export const NODE_RUNTIME_DARWIN_MINIMUM_OS = '13.5'

export function isCompatServerTarget(target: string): target is CompatServerTarget {
  return COMPAT_SERVER_TARGETS.some((known) => known === target)
}

export function isNodeRuntimeTarget(target: string): target is NodeRuntimeTarget {
  return isCompatServerTarget(target) || SERVER_TARGETS.some((known) => known === target)
}

/** The pinned asset for a known default or compat target. */
export function pinnedNodeRuntimeAsset(target: NodeRuntimeTarget): NodeRuntimeAsset {
  return isCompatServerTarget(target)
    ? NODE_RUNTIME_COMPAT_ASSETS[target]
    : NODE_RUNTIME_ASSETS[target]
}

/** The pinned asset for a default or compat target; undefined for anything else. */
export function nodeRuntimeAsset(target: string): NodeRuntimeAsset | undefined {
  if (isCompatServerTarget(target)) {
    return NODE_RUNTIME_COMPAT_ASSETS[target]
  }
  const server = SERVER_TARGETS.find((known) => known === target)
  return server ? NODE_RUNTIME_ASSETS[server] : undefined
}

const NODE_RUNTIME_BASE_URLS: Record<NodeRuntimeAssetSource, string> = {
  official: 'https://nodejs.org/dist',
  unofficial: 'https://unofficial-builds.nodejs.org/download/release'
}

export function nodeRuntimeReleaseUrl(
  source: NodeRuntimeAssetSource,
  file: string,
  version: string = NODE_RUNTIME_PIN.version
): string {
  return `${NODE_RUNTIME_BASE_URLS[source]}/v${version}/${file}`
}

export function nodeRuntimeHeadersUrl(pin: NodeRuntimePin = NODE_RUNTIME_PIN): string {
  return nodeRuntimeReleaseUrl('official', pin.headers.file, pin.version)
}

export function isWindowsServerTarget(target: string): target is WindowsServerTarget {
  return target === 'win32-x64' || target === 'win32-arm64'
}

/** Archive-relative path of the executable, e.g. node-v24.21.0-linux-x64/bin/node. */
export function nodeRuntimeExecutablePath(target: NodeRuntimeTarget, archive: string): string {
  const topLevel = archive.replace(/\.(?:tar\.gz|tar\.xz|zip)$/, '')
  return target.startsWith('win32-') ? `${topLevel}/node.exe` : `${topLevel}/bin/node`
}
