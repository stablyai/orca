/** Keeps grouped and escaped commas inside globs so search engines receive complete patterns. */
export function splitSearchGlobPatterns(patterns: string, engine: 'rg' | 'git' = 'rg'): string[] {
  const out: string[] = []
  let current = ''
  let escaping = false
  let braceDepth = 0
  let characterClassContentStart = -1
  let posixClassStart = -1
  for (let index = 0; index < patterns.length; index += 1) {
    const ch = patterns[index]
    if (escaping) {
      current += `\\${ch}`
      escaping = false
      continue
    }
    // Ripgrep treats backslashes literally inside classes; Git uses them as escapes.
    if (ch === '\\' && (characterClassContentStart === -1 || engine === 'git')) {
      escaping = true
      continue
    }
    if (characterClassContentStart !== -1) {
      // A leading ']' (also after negation) is a member, not the end of the class.
      if (posixClassStart !== -1) {
        if (ch === ']') {
          // An incomplete POSIX opener can just be literal '[' and ':' members.
          if (patterns[index - 1] !== ':' || index <= posixClassStart + 3) {
            characterClassContentStart = -1
          }
          posixClassStart = -1
        }
      } else if (engine === 'git' && ch === '[' && patterns[index + 1] === ':') {
        posixClassStart = index
      } else if (ch === ']' && index > characterClassContentStart) {
        characterClassContentStart = -1
      }
    } else if (ch === '[') {
      const next = patterns[index + 1]
      characterClassContentStart = index + (next === '!' || next === '^' ? 2 : 1)
    } else if (ch === '{') {
      braceDepth += 1
    } else if (ch === '}') {
      braceDepth = Math.max(0, braceDepth - 1)
    }
    if (ch === ',' && braceDepth === 0 && characterClassContentStart === -1) {
      const trimmed = current.trim()
      if (trimmed) {
        out.push(trimmed)
      }
      current = ''
      continue
    }
    current += ch
  }
  if (escaping) {
    current += '\\'
  }
  const trimmed = current.trim()
  if (trimmed) {
    out.push(trimmed)
  }
  return out
}

export function toGitGlobPathspec(glob: string, exclude?: boolean): string {
  const needsRecursive = !glob.includes('/')
  const pattern = needsRecursive ? `**/${glob}` : glob
  return exclude ? `:(exclude,glob)${pattern}` : `:(glob)${pattern}`
}

export function toGitGlobPathspecs(glob: string, exclude?: boolean): string[] {
  const directoryOnly = /\/+$/u.test(glob)
  const trimmed = glob.replace(/\/+$/, '')
  if (!trimmed) {
    return []
  }
  const pathspec = toGitGlobPathspec(trimmed, exclude)
  return directoryOnly ? [`${pathspec}/**`] : [pathspec, `${pathspec}/**`]
}
