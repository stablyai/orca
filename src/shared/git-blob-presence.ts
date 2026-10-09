// only a successful empty listing proves absence
export async function probeGitBlobPresence(
  gitBuffer: (args: string[]) => Promise<Buffer>,
  filePath: string,
  oid?: string
): Promise<boolean | 'unmerged' | null> {
  // listing the tree/index bypasses [smudge], whose failures also exit [128]
  const pathspec = `:(literal)${filePath}`
  const args = oid
    ? ['ls-tree', '-z', '--', oid, pathspec]
    : ['ls-files', '--stage', '-z', '--', pathspec]
  try {
    const output = await gitBuffer(args)
    if (output.length === 0) {
      return false
    }
    if (oid) {
      return true
    }
    const stages = output
      .toString('utf8')
      .split('\0')
      .filter(Boolean)
      .map((entry) => entry.match(/^\d{6} [a-f0-9]+ ([0-3])\t/)?.[1])
    if (stages.some((stage) => stage === undefined)) {
      return null
    }
    return stages.includes('0') ? true : 'unmerged'
  } catch {
    return null
  }
}
