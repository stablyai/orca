// Why: two guards need the same answer to "is this a recursive removal that forgot the retries?" —
// the Windows CI lane's teardowns and the product paths that delete something a user created. One
// scanner so a spelling either guard cannot see is a gap in neither rather than a gap in one.

/** `node:fs` and `node:fs/promises`, spelled with or without the `node:` prefix. */
const FS_SPECIFIER = String.raw`['"](?:node:)?fs(?:/promises)?['"]`
/** The `{ … }` clause of an fs import or require, which is where a rename would be declared. */
const FS_BINDING_CLAUSE = new RegExp(
  String.raw`\{([^}]*)\}\s*(?:from\s*${FS_SPECIFIER}|=\s*(?:await\s+import|require)\(\s*${FS_SPECIFIER})`,
  'g'
)
/** `rm as removeDir` or `rmSync: dropTree` — the two ways a binding gets a local name. */
const RENAMED_REMOVAL = /\brm(?:Sync)?\s*(?:as|:)\s*([A-Za-z0-9_$]+)/g

/**
 * The local names a recursive removal can be called by in `source`.
 *
 * Namespaced spellings are covered by the optional `<identifier>.` prefix in the matcher rather
 * than by listing names, so `fsp.rm` and `fsPromises.rm` are caught without anyone having to teach
 * the rule that spelling first. Renames are the one form that prefix cannot see, so they are read
 * out of the import clause.
 */
function collectRemovalNames(source: string): string[] {
  const names = new Set(['rmSync', 'rm'])
  for (const clause of source.matchAll(FS_BINDING_CLAUSE)) {
    for (const rename of clause[1].matchAll(RENAMED_REMOVAL)) {
      names.add(rename[1])
    }
  }
  return [...names]
}

/**
 * The 1-based line of every recursive removal in `source` that hands Node no retry count.
 *
 * Renames are read out of `source`'s own import clauses, so pass a whole file rather than a
 * fragment when the call and its import live together.
 */
export function findRawRecursiveRemovals(source: string): number[] {
  const offenders: number[] = []
  const call = new RegExp(
    String.raw`(?<![\w$.])(?:[\w$]+\.)?(?:${collectRemovalNames(source).join('|')})\s*\(`,
    'g'
  )
  let match: RegExpExecArray | null
  while ((match = call.exec(source)) !== null) {
    // Read to the call's closing paren so multi-line option objects are covered.
    let depth = 0
    let end = match.index + match[0].length - 1
    for (; end < source.length; end += 1) {
      if (source[end] === '(') {
        depth += 1
      } else if (source[end] === ')') {
        depth -= 1
        if (depth === 0) {
          break
        }
      }
    }
    const args = source.slice(match.index, end + 1)
    if (!args.includes('recursive')) {
      continue
    }
    if (args.includes('maxRetries')) {
      continue
    }
    offenders.push(source.slice(0, match.index).split('\n').length)
  }
  return offenders
}
