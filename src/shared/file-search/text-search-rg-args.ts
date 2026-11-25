import type { SearchOptions } from './code-search-types'
import { splitSearchGlobPatterns } from './text-search-glob-patterns'

// Why: keep search cheaper than opening a file; the editor read path has a larger cap (Monaco large-file handling).
const SEARCH_MAX_FILE_SIZE = 5 * 1024 * 1024

export type SearchOptionsLike = Pick<
  SearchOptions,
  | 'caseSensitive'
  | 'wholeWord'
  | 'useRegex'
  | 'includePattern'
  | 'excludePattern'
  | 'includeIgnored'
>

/** Use target . with cwd at the search root so anchored globs match root-relative paths. */
export function buildRgArgs(query: string, target: string, opts: SearchOptionsLike): string[] {
  const args: string[] = [
    '--no-config',
    '--json',
    '--hidden',
    '--glob',
    '!.git',
    '--max-filesize',
    `${Math.floor(SEARCH_MAX_FILE_SIZE / 1024 / 1024)}M`
  ]
  if (!opts.caseSensitive) {
    args.push('--ignore-case')
  }
  if (opts.wholeWord) {
    args.push('--word-regexp')
  }
  if (!opts.useRegex) {
    args.push('--fixed-strings')
  }
  // Only VCS ignore is widened; .ignore/.rgignore and the .git glob above still apply.
  if (opts.includeIgnored) {
    args.push('--no-ignore-vcs')
  }
  if (opts.includePattern) {
    for (const pat of splitSearchGlobPatterns(opts.includePattern, 'rg')) {
      args.push('--glob', pat)
    }
  }
  if (opts.excludePattern) {
    for (const pat of splitSearchGlobPatterns(opts.excludePattern, 'rg')) {
      args.push('--glob', `!${pat}`)
    }
  }
  args.push('--', query, target)
  return args
}
