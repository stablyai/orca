export const ORCAD_BUN_VERSION = '1.4.0'

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

export type OrcadBunReleaseAsset = {
  filename: string
  sha256: string
  executableSha256: string
}

export const ORCAD_BUN_RELEASE_ASSETS: Record<OrcadBunTarget, OrcadBunReleaseAsset> = {
  'darwin-arm64': {
    filename: 'bun-darwin-aarch64.zip',
    sha256: 'c669e97f6164e1c96e0701748db98dfa77492908cbd8394c7557134a735de381',
    executableSha256: '539598c775882420b9d8deb7dc14d845f20f7d26f5600c50ab067dde6ac3f3bf'
  },
  'darwin-x64': {
    filename: 'bun-darwin-x64.zip',
    sha256: '1d0211b8f1dc991182344687ad15e72ee86f154845a5f7fa477994cd341dd9b0',
    executableSha256: 'ca8a18d0116d7b6b19f53bb0d8c48e487c0757cab4dc3f4f8cc5e43a44cd75d8'
  },
  'linux-arm64-glibc': {
    filename: 'bun-linux-aarch64.zip',
    sha256: '4b1a332ee861983eb93bcfe6f770fff94e3e31b2c388bdaea3c8ed35e58eed0e',
    executableSha256: '086c4121c8738a8e0f5ed730e8a461bc3973b4444e372ddb77aef9a747fa2ae9'
  },
  'linux-x64-glibc': {
    filename: 'bun-linux-x64.zip',
    sha256: '2d03fb5fb83ac8b567aca0a281b2ce1a1a19d488f56c2968d88c3f25e92fe452',
    executableSha256: '33d56b070be6a9e3da0ab013038b43d1645d0534ca811ecdba4472599117eb4b'
  },
  'linux-arm64-musl': {
    filename: 'bun-linux-aarch64-musl.zip',
    sha256: '576300ce33ff16ffcd455bf178c2f095f9df845c6cc3d0284ba1c96ca0e80473',
    executableSha256: '1d1810e9a442bbd09a07962ef4efa3105a989c71033eedec0bd1b0bdd59958a3'
  },
  'linux-x64-musl': {
    filename: 'bun-linux-x64-musl.zip',
    sha256: '83b5f12fd258dd8d4fdcaea65ede954366aa717dab399e20093ecab280d54e7a',
    executableSha256: '805ecd8b91244de1c14d8d7e24841add8cb15c4eefffd17ce3d93cb87b3162ed'
  },
  'win32-arm64': {
    filename: 'bun-windows-aarch64.zip',
    sha256: 'f473bfe2df73ee770548c93dd5d380aea7120c218ec2aa1afdd0bbba7bf18c47',
    executableSha256: '00cf2c040f04281cf9324282a84338c2dfe6597007bf73b7ee888d512297d71f'
  },
  'win32-x64': {
    filename: 'bun-windows-x64.zip',
    sha256: 'e6f093d39da486b20262ca8cdd5ed6a9e8bc9c2f275b78e6d3a0c5b28cc95901',
    executableSha256: '627d2e4775c24bdedee2cd7ccc18dcadae061e5345274ab6e3c4c797927bfb8f'
  }
}

export function orcadBunReleaseUrl(asset: OrcadBunReleaseAsset): string {
  return `https://github.com/oven-sh/bun/releases/download/bun-v${ORCAD_BUN_VERSION}/${asset.filename}`
}
