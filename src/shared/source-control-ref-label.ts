// Drop Git namespace prefixes but retain remote qualification to distinguish multi-remote bases.
export function formatSourceControlRefLabel(ref: string): string {
  return ref
    .trim()
    .replace(/^refs\/remotes\//, '')
    .replace(/^refs\/heads\//, '')
    .replace(/^refs\/tags\//, '')
}
