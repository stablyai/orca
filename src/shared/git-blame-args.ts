/** `git blame` argv; `--contents -` blames stdin so unsaved editor lines map to the buffer. */
export function buildGitBlameArgs(filePath: string, withStdinContents: boolean): string[] {
  return [
    'blame',
    '--porcelain',
    ...(withStdinContents ? ['--contents', '-'] : []),
    '--',
    // Why: Git pathspecs expect forward slashes even on Windows.
    filePath.replace(/\\/g, '/')
  ]
}
