// Why: the removal-policy guards assert over one named region of a file rather than the whole
// file, so both need the same answer to "where does this region's body end?". Reading it wrong is
// silent — a truncated body has nothing in it to flag, so the guard passes for the wrong reason.

/**
 * The text of `region` in `source`, from the start of its signature to the brace that closes its
 * body.
 *
 * The body's opening brace is the first `{` outside both the argument list and the return type, so
 * neither an inline object parameter (`f(input: { a: string })`) nor an object return type
 * (`: Promise<{ ok: true }>`) ends the region on the signature. Getting either wrong is silent: the
 * caller gets a body with nothing in it to flag. Returns `null` when the region is absent.
 */
export function readSourceRegionBody(source: string, region: string): string | null {
  const start = source.indexOf(region)
  if (start === -1) {
    return null
  }
  let parens = 0
  let angles = 0
  let open = -1
  for (let i = start; i < source.length; i += 1) {
    const char = source[i]
    if (char === '(') {
      parens += 1
    } else if (char === ')') {
      parens -= 1
    } else if (parens === 0 && char === '<') {
      angles += 1
    } else if (parens === 0 && char === '>') {
      // Clamped so the `>` of an arrow signature cannot drive the depth negative.
      angles = Math.max(0, angles - 1)
    } else if (char === '{' && parens === 0 && angles === 0) {
      open = i
      break
    }
  }
  if (open === -1) {
    return null
  }
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') {
      depth += 1
    } else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) {
        return source.slice(start, i + 1)
      }
    }
  }
  return null
}
