export const ORCAD_BUN_VERSION = '1.4.2'

export const ORCAD_BUN_TARGETS = [
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64-glibc',
  'linux-x64-glibc',
  'linux-arm64-musl',
  'linux-x64-musl',
  'win32-arm64',
  'win32-x64'
] as const

export type OrcadBunTarget = (typeof ORCAD_BUN_TARGETS)[number]

// Managed SSH deployment supports POSIX hosts; Windows uses standalone builds.
export const ORCAD_TEMPLATE_TARGETS = ORCAD_BUN_TARGETS.filter(
  (target) => !target.startsWith('win32-')
)

export type OrcadBunReleaseAsset = {
  filename: string
  sha256: string
  executableSha256: string
}

export const ORCAD_BUN_RELEASE_ASSETS: Record<OrcadBunTarget, OrcadBunReleaseAsset> = {
  'darwin-arm64': {
    filename: 'bun-darwin-aarch64.zip',
    sha256: '90987a3a16d7db556d886ac3d551e7b6d3edf0a1cf43acaed622e8676be1d12f',
    executableSha256: '35d20dd0263e5c950194434b925454fdfa9ba6e4467da960410fa05b08a7a5b5'
  },
  'darwin-x64': {
    filename: 'bun-darwin-x64.zip',
    sha256: '80520d7e17526308c9185d261679ac6d27798d3803a0e9f7ff9121ab8affb012',
    executableSha256: '2fa513af22ac59e03aae640cad302e73cb1ddb0f6398501e2ddccf7dcd613596'
  },
  'linux-arm64-glibc': {
    filename: 'bun-linux-aarch64.zip',
    sha256: '54328bbc2d9c8e0c9f892c544d66c57a83b84139e34909e5ee81758f1ac8fda7',
    executableSha256: '616f267a34278ff5ac282df37ffdfba1d7141f4f6926bca99af2cd6ef3ad32b1'
  },
  'linux-x64-glibc': {
    filename: 'bun-linux-x64.zip',
    sha256: '36368faef7527875d5ffa52e53cd48021741f2a83eb6208a8dd64068d422a913',
    executableSha256: 'a83d263767d839e4d2649ca8e35d07159c7afc99afdc96d731ced29e056dda0c'
  },
  'linux-arm64-musl': {
    filename: 'bun-linux-aarch64-musl.zip',
    sha256: '71760b6c8ea30623b81a4907cb815d48e2ea266f2e73e751534a44a0607950df',
    executableSha256: '1101cd0aa92ea214c2aaf4bb3761ca3c76a90aae0e6f94c07efb4e8c4f18a8fc'
  },
  'linux-x64-musl': {
    filename: 'bun-linux-x64-musl.zip',
    sha256: '4835eca59d6da70f4674f5642f6e459dcadab773695b2ed9922d131057989742',
    executableSha256: '16b72935ffd7a503b978c186874539c92aade4e3515b70a5abf5db2581fdef7d'
  },
  'win32-arm64': {
    filename: 'bun-windows-aarch64.zip',
    sha256: 'a7a16b876a305fd1029c66dbd27007b4f6112ae896532f675878731a21e50cfd',
    executableSha256: '3d7e98d3201c55c3bde6c069a5dfa0d34da9edc9145187c76594f685f8aa54c6'
  },
  'win32-x64': {
    filename: 'bun-windows-x64.zip',
    sha256: 'ce4c17497b2f29712a99d3d53f028de28cd42e3bacb8589599e7f000e49b6405',
    executableSha256: '15277c59ccd6c6c20f8dc9716c2b59c1776320d606b6a8658f70be8799519ca4'
  }
}

export function orcadBunReleaseUrl(asset: OrcadBunReleaseAsset): string {
  return `https://github.com/oven-sh/bun/releases/download/bun-v${ORCAD_BUN_VERSION}/${asset.filename}`
}
