import type { AgentJournalSkillRef } from './agent-session-journal-types'

/** Binds composer selections to distinct visible tokens; unmatched files are not draft selections. */
export function composerSkillOccurrences(
  text: string,
  skills: readonly AgentJournalSkillRef[]
): { ref: AgentJournalSkillRef; at: number }[] {
  const paths = new Set<string>()
  const occupied = new Set<number>()
  const bindings: { ref: AgentJournalSkillRef; at: number }[] = []
  for (const ref of skills) {
    if (paths.has(ref.path)) {
      continue
    }
    const token = `$${ref.name}`
    for (let at = text.indexOf(token); at !== -1; at = text.indexOf(token, at + 1)) {
      if (!occupied.has(at) && !/[\w:-]/u.test(text.charAt(at + token.length))) {
        paths.add(ref.path)
        occupied.add(at)
        bindings.push({ ref, at })
        break
      }
    }
  }
  return bindings.sort((left, right) => left.at - right.at)
}
