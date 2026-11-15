export function encodeGitPathspecs(pathspecs: readonly string[]): string {
  if (pathspecs.some((pathspec) => pathspec.includes('\0'))) {
    throw new Error('Git pathspecs cannot contain NUL bytes')
  }
  return pathspecs.length > 0 ? `${pathspecs.join('\0')}\0` : ''
}
