export function splitSearchGlobPatterns(patterns: string): string[] {
  const out: string[] = []
  let current = ''
  let escaping = false
  for (const ch of patterns) {
    if (escaping) {
      current += `\\${ch}`
      escaping = false
      continue
    }
    if (ch === '\\') {
      escaping = true
      continue
    }
    if (ch === ',') {
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
