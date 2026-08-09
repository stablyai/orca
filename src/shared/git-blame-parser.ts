import type { GitBlameLine, GitBlameResult } from './git-blame'

const UNCOMMITTED_SHA = '0'.repeat(40)

/**
 * Parses `git blame --porcelain` output into a per-line result array.
 *
 * Porcelain format, two shapes per file line:
 *   First occurrence of a commit sha:
 *     <sha> <orig-line> <final-line> <count>
 *     author <name>  …  (full metadata block)
 *     filename <filename>
 *     \t<line-content>
 *
 *   Repeated occurrence of the same sha (NO metadata block, NO filename line):
 *     <sha> <orig-line> <final-line>
 *     \t<line-content>
 */
export function parseBlameOutput(output: string): GitBlameResult {
  const lines = output.split('\n')
  const commitCache = new Map<string, Omit<GitBlameLine, 'sha' | 'shortSha'>>()
  const result: GitBlameResult = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i] ?? ''

    // Header: <sha40> <orig-line> <final-line> [<count>]
    const header = /^([0-9a-f]{40}) \d+ (\d+)/.exec(line)
    if (!header) {
      i++
      continue
    }
    const sha = header[1]!.toLowerCase()
    const finalLine = Number.parseInt(header[2]!, 10)
    i++

    if (sha === UNCOMMITTED_SHA) {
      result[finalLine - 1] = null
      continue
    }

    // Collect per-commit metadata.
    // For the FIRST occurrence of a sha the block ends with `filename <f>`.
    // For REPEATED occurrences there is no metadata block at all — the very
    // next line is the tab-prefixed content line. Stop the inner loop on
    // either sentinel so we never over-run into the next header.
    let author = ''
    let authorTime = 0
    let summary = ''
    while (i < lines.length) {
      const meta = lines[i] ?? ''
      if (meta.startsWith('\t')) {
        i++
        break
      }
      if (/^[0-9a-f]{40} \d+ \d+/.test(meta)) {
        break
      }
      if (meta.startsWith('filename ')) {
        i++
        break
      }
      if (meta.startsWith('author ')) {
        author = meta.slice('author '.length)
      } else if (meta.startsWith('author-time ')) {
        authorTime = Number.parseInt(meta.slice('author-time '.length), 10) || 0
      } else if (meta.startsWith('summary ')) {
        summary = meta.slice('summary '.length)
      }
      i++
    }

    const cached = commitCache.get(sha) ?? { author, authorTime, summary }
    commitCache.set(sha, cached)
    result[finalLine - 1] = {
      sha,
      shortSha: sha.slice(0, 7),
      ...cached
    }
  }

  return result
}
