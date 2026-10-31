export const CLAUDE_RICH_OUTPUT_DIR = 'claude-rich-output'
export const CLAUDE_RICH_OUTPUT_MANIFEST = `${CLAUDE_RICH_OUTPUT_DIR}/manifest.json`

export function isClaudeRichOutputAsset(path: string): boolean {
  return (
    path.startsWith(`${CLAUDE_RICH_OUTPUT_DIR}/`) &&
    path !== CLAUDE_RICH_OUTPUT_MANIFEST &&
    /^[A-Za-z0-9._@+~-]+(?:\/[A-Za-z0-9._@+~-]+)*$/.test(path) &&
    !path.split('/').some((part) => part === '.' || part === '..')
  )
}

export function claudeRichOutputTemplateAssetFilenames(
  commonSha256: Readonly<Record<string, string>>
): string[] {
  const assets = Object.keys(commonSha256)
    .filter(
      (path) =>
        path.startsWith(`${CLAUDE_RICH_OUTPUT_DIR}/`) && path !== CLAUDE_RICH_OUTPUT_MANIFEST
    )
    .sort()
  if (assets.some((path) => !isClaudeRichOutputAsset(path))) {
    throw new Error('Packaged orcad template names an unsafe rich output asset')
  }
  return assets
}

export function claudeRichOutputAssetFilenames(contents: string): string[] {
  const manifest: unknown = JSON.parse(contents)
  if (
    !manifest ||
    typeof manifest !== 'object' ||
    !('assets' in manifest) ||
    !Array.isArray(manifest.assets) ||
    manifest.assets.length === 0 ||
    manifest.assets.length > 20000
  ) {
    throw new Error('Invalid Claude rich output asset manifest')
  }
  const assets = manifest.assets.map((path: unknown) => {
    if (typeof path !== 'string' || !isClaudeRichOutputAsset(path)) {
      throw new Error(`Unsafe Claude rich output asset path: ${JSON.stringify(path)}`)
    }
    return path
  })
  if (new Set(assets).size !== assets.length) {
    throw new Error('Duplicate Claude rich output asset path')
  }
  return assets.sort()
}
