const MAX_LFS_POINTER_BYTES = 1024

function isLfsPointer(buffer: Buffer): boolean {
  if (buffer.length >= MAX_LFS_POINTER_BYTES) {
    return false
  }
  const pointer = buffer.toString('utf8')
  return (
    /^version (?:https:\/\/(?:git-lfs|hawser)\.github\.com\/spec\/v1|http:\/\/git-media\.io\/v\/2)\r?\n/.test(
      pointer
    ) &&
    /^oid sha256:[a-f0-9]{64}\r?$/m.test(pointer) &&
    /^size [0-9]+\r?$/m.test(pointer)
  )
}

export async function resolveGitLfsPreview(
  buffer: Buffer,
  filePath: string,
  gitBuffer: (args: string[], stdin: string) => Promise<Buffer>
): Promise<Buffer> {
  if (!isLfsPointer(buffer)) {
    return buffer
  }
  // historical LFS pointers must resolve even when current attributes no longer enable LFS
  const content = await gitBuffer(
    ['-c', 'lfs.fetchinclude=', '-c', 'lfs.fetchexclude=', 'lfs', 'smudge', '--', filePath],
    buffer.toString('utf8')
  )
  // skip-smudge and download-error settings can report success while returning the pointer
  if (isLfsPointer(content)) {
    throw new Error('Git LFS preview could not be resolved')
  }
  return content
}
