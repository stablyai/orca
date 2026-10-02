/** null means the probe failed; only a successful empty listing proves absence. */
export async function probeGitBlobPresence(
  gitBuffer: (args: string[]) => Promise<Buffer>,
  filePath: string,
  oid?: string
): Promise<boolean | null> {
  // Why: listing the tree/index bypasses smudge, whose failures also exit 128.
  const pathspec = `:(literal)${filePath}`
  const args = oid
    ? ['ls-tree', '-z', '--', oid, pathspec]
    : ['ls-files', '--stage', '-z', '--', pathspec]
  try {
    return (await gitBuffer(args)).length > 0
  } catch {
    return null
  }
}
