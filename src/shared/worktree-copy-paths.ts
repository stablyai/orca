/** Literal paths shared by the project manifest and repository copy picker. */
export function parseWorktreeIncludeFile(content: string): string[] {
  return [
    ...new Set(
      content
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#'))
        .map((line) => line.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, ''))
    )
  ]
}

export function isWorktreeCopyPath(path: string): boolean {
  const parts = path.split('/')
  return (
    Boolean(path) &&
    path.length <= 4096 &&
    !/^[a-z]:/i.test(path) &&
    ![...path].some((character) => character.charCodeAt(0) < 32) &&
    !/[*?]/.test(path) &&
    !path.startsWith('!') &&
    !path.includes('\\') &&
    parts.every(
      (part) =>
        part !== '' &&
        part !== '.' &&
        part !== '..' &&
        !/^\.git[ .]*$/i.test(part) &&
        !part.includes(':') &&
        !/[ .]$/.test(part) &&
        !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
    )
  )
}

export function isWorktreeCopyPathList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= 1000 &&
    value.every((entry) => typeof entry === 'string' && isWorktreeCopyPath(entry))
  )
}
