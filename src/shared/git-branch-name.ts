const FORBIDDEN_GIT_BRANCH_CHARACTERS = new Set([' ', '~', '^', ':', '?', '*', '[', '\\'])

/** Git 2.25 `check-ref-format` rules for literals that survive Node argv encoding;
 * `@{-n}` stays rejected because repo-local shorthand cannot be a shared Mission name. */
export function isValidGitBranchName(branchName: string): boolean {
  if (
    branchName.length === 0 ||
    branchName === 'HEAD' ||
    branchName.startsWith('-') ||
    branchName.startsWith('/') ||
    branchName.endsWith('/') ||
    branchName.endsWith('.') ||
    branchName.includes('//') ||
    branchName.includes('..') ||
    branchName.includes('@{')
  ) {
    return false
  }
  if (
    branchName.split('/').some((component) => {
      return component.startsWith('.') || component.endsWith('.lock')
    })
  ) {
    return false
  }
  for (const character of branchName) {
    const codePoint = character.codePointAt(0) ?? 0
    if (
      codePoint < 0x20 ||
      codePoint === 0x7f ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
      FORBIDDEN_GIT_BRANCH_CHARACTERS.has(character)
    ) {
      return false
    }
  }
  return true
}
