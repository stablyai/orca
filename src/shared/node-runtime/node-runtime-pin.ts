/** Pinned external Node runtime (docs/reference/node-runtime-design.html D1). Keep erasable TypeScript only:
 * Node build scripts import via type stripping, which rejects enums/namespaces/parameter properties. */

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

// Include every target for Windows SSH node-pty/ConPTY slots (D5), although managed orcad launch remains POSIX-only (orcad-remote-host-support.ts).
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

// @generated-begin by config/scripts/node-runtime/archive-identity/update-node-runtime-pin.mjs
export const NODE_RUNTIME_PIN: NodeRuntimePin = {
  version: '24.22.3',
  electron: '45.4.1',
  napi: 10,
  headers: {
    file: 'node-v24.22.3-headers.tar.gz',
    sha256: 'bc93bde109befc916a62348caae708a48f9550150d786398fea2d773607c18da'
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
    archive: 'node-v24.22.3-darwin-arm64.tar.gz',
    archiveSha256: 'ff6e17d4874b76d272212b908cc020d6e815fba5a6c7eaaa06add725840307fd',
    executableSha256: 'ba7073582822078d8c90bca3facacc46690bc5366fab4b815aeef9148cd6e854',
    executableSize: 122586000
  },
  'darwin-x64': {
    source: 'official',
    archive: 'node-v24.22.3-darwin-x64.tar.gz',
    archiveSha256: '977614af0504c81045e7fd85596dbca0e5f951b96681516dadafedcca8c447f7',
    executableSha256: '796184b9a19ed300b1ba7cd0f7e49558fee9fc0f05080bb036025490a5a2edf3',
    executableSize: 125755312
  },
  'linux-arm64-glibc': {
    source: 'official',
    archive: 'node-v24.22.3-linux-arm64.tar.gz',
    archiveSha256: '261af2af250dfd7e9f25cf151d1b2713a0adf8f10a9ad116c4947f68627affe8',
    executableSha256: '8f9c2a55879e9705cb285b6cdd649d95df642c6720f052cb30f300d2677da99f',
    executableSize: 123446736
  },
  'linux-x64-glibc': {
    source: 'official',
    archive: 'node-v24.22.3-linux-x64.tar.gz',
    archiveSha256: '061ec3e3062115705b56b51fa9cc330ab50d34b6969387d4e4b1a50c6809acc2',
    executableSha256: 'a7ec1b37e6ff9d187e4198c5b6df9a4eb1c74dd31804fb3bac55cc4ceca1ac01',
    executableSize: 126891984
  },
  'linux-arm64-musl': {
    source: 'unofficial',
    archive: 'node-v24.22.3-linux-arm64-musl.tar.gz',
    archiveSha256: '248c96a84f6c8338646b9fd73bf125124678f8fb08db5f23023f462055e0eedc',
    executableSha256: '1851ee7c211e9352bf9d79c90d447f47ef8a678ed7e612371c3683099a699c8b',
    executableSize: 129136528
  },
  'linux-x64-musl': {
    source: 'official',
    archive: 'node-v24.22.3-linux-x64-musl.tar.gz',
    archiveSha256: '5499b663f62c72093715da98f4aea6f83427ad8bab9cf9c75f0924e0e456ce14',
    executableSha256: '7e027679034844bb06f53bead732673553cf5bb0de424bbbd257b35c989d34b0',
    executableSize: 132502712
  },
  'win32-arm64': {
    source: 'official',
    archive: 'node-v24.22.3-win-arm64.zip',
    archiveSha256: 'b3cc74a295b39d4f273271e96f58c06dd2b35757ca12abec64c7d0598b434f14',
    executableSha256: '172e320db179ce416fc012b96b9917dacfb442beb081de57c4deaed7b5a24644',
    executableSize: 82173768
  },
  'win32-x64': {
    source: 'official',
    archive: 'node-v24.22.3-win-x64.zip',
    archiveSha256: 'e612af99f626ab415ea225af6bce5c971feb448cb5cae250bb1c3fa50c5f7d9f',
    executableSha256: '86fc4785327db5f5c7558dc6156c543b433c313e813a222e088086222ab4afa6',
    executableSize: 93944648
  }
}

export const NODE_RUNTIME_COMPAT_ASSETS: Record<CompatServerTarget, NodeRuntimeAsset> = {
  'linux-x64-glibc217': {
    source: 'unofficial',
    archive: 'node-v24.22.3-linux-x64-glibc-217.tar.gz',
    archiveSha256: '773167bade05e3b2a9b34a6a58ca176274818f45dbbbf13c9d81726a04b9b3b5',
    executableSha256: 'd09440b3d78298e285c342a2f15a0924c278e0a2cfbbc1b057f8e5ebf69bbd43',
    executableSize: 139808056
  }
}
// @generated-end

/** Pinned darwin Node LC_BUILD_VERSION minos sets terminal-host floor. Packaging catches pin drift; older macOS uses desktop-forked daemons. */
export const NODE_RUNTIME_DARWIN_MINIMUM_OS = '13.5'

/** Pinned Node supports Windows 10 / Server 2016 and later; 10240 is the first Windows 10 build. */
export const NODE_RUNTIME_WINDOWS_MINIMUM_BUILD = 10240

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
