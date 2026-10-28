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

// @generated-begin by config/scripts/update-node-runtime-pin.mjs
export const NODE_RUNTIME_PIN: NodeRuntimePin = {
  version: '24.22.1',
  electron: '43.8.1',
  napi: 10,
  headers: {
    file: 'node-v24.22.1-headers.tar.gz',
    sha256: '322e0a27db9088093ab8347bdc8c7e0aaa21dc9ed548390bf06b394494c09267'
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
    archive: 'node-v24.22.1-darwin-arm64.tar.gz',
    archiveSha256: '89c682593d76cd44233fa53b1563264e7de9cbb189cad169135c5b4fadfbc0a7',
    executableSha256: '6f32069480ec14d52b6d7b1f3c7124cfbbc46203abf5ddf5c65b127435f3f329',
    executableSize: 122545856
  },
  'darwin-x64': {
    source: 'official',
    archive: 'node-v24.22.1-darwin-x64.tar.gz',
    archiveSha256: 'd132557e7ee2b85af08b0c8c34338e65c6430f2238d01f727728ef42dc83b035',
    executableSha256: 'cc6f41f72e3eb4460154952e56a35afdd96b6995cea51cd25e637355a2955a51',
    executableSize: 125715808
  },
  'linux-arm64-glibc': {
    source: 'official',
    archive: 'node-v24.22.1-linux-arm64.tar.gz',
    archiveSha256: '33c37be234ba8bee041961047b19160f4d7d0f164e8e246f78bdd10feff148b3',
    executableSha256: 'c8c5721679d8d1a09e9987e345d5f9a64899bb85f7a384783ba8a93e6e62348a',
    executableSize: 123377224
  },
  'linux-x64-glibc': {
    source: 'official',
    archive: 'node-v24.22.1-linux-x64.tar.gz',
    archiveSha256: 'eb6728e77c576a35162c122c45ccadf224d89ff00abc8dae46cc2897c6002d7c',
    executableSha256: 'e32e2d16081cf644f88392934288086e7662529d0d43277c34f7aad2207cfafb',
    executableSize: 126879696
  },
  'linux-arm64-musl': {
    source: 'unofficial',
    archive: 'node-v24.22.1-linux-arm64-musl.tar.gz',
    archiveSha256: '8254125825a3e5e834bd8a260dab4c8303f720464a741506ec27989b9ba1769b',
    executableSha256: '211a0371ba3e565863ae5358ffd06bc4fb4ffb0e53689d82c9a5b286ab4ad8d1',
    executableSize: 129067232
  },
  'linux-x64-musl': {
    source: 'official',
    archive: 'node-v24.22.1-linux-x64-musl.tar.gz',
    archiveSha256: '9b250d29d6ab8ae38dd23019e2c04a6d6b2916ab1dad721c5f6e1da2b2901c6a',
    executableSha256: '569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108',
    executableSize: 132485920
  },
  'win32-arm64': {
    source: 'official',
    archive: 'node-v24.22.1-win-arm64.zip',
    archiveSha256: 'a0c807319fede24c4a0d8f84564c82a619bd313b16b10c007c383c2609e99171',
    executableSha256: '8bea91dc437fe01e7d92ef0efc6c9eaf654369aaba9b2d3e9841552ea7b95a00',
    executableSize: 82150728
  },
  'win32-x64': {
    source: 'official',
    archive: 'node-v24.22.1-win-x64.zip',
    archiveSha256: 'd2046d28c2c3dcd211ac5145c0bf30e2047ef9dfb306693c8c6e2eccd8b95fa5',
    executableSha256: 'd702daa815eabbff763c7d3808e235cf031cf2ca70211b56847bc72f51e240e5',
    executableSize: 93915464
  }
}

export const NODE_RUNTIME_COMPAT_ASSETS: Record<CompatServerTarget, NodeRuntimeAsset> = {
  'linux-x64-glibc217': {
    source: 'unofficial',
    archive: 'node-v24.22.1-linux-x64-glibc-217.tar.gz',
    archiveSha256: '422ddeec2c08902a34ef80ae25de388c7b7e2920763030a5262d56b10675c570',
    executableSha256: '6ecc984d4bd0ff3012e91efa39eaf5f7e519037d5b1cbab8a6e1bb5c7914e18a',
    executableSize: 139795880
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
