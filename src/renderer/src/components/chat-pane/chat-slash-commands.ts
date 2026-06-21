// orca-side "/" quick commands for the jcode chat composer. These are
// ORCA-provided prompt templates + actions, NOT jcode skills (jcode headless has
// none). A 'template' inserts/replaces the draft text; an 'action' runs a
// composer-level callback (e.g. start a new chat). FEATURE B adds a 'skill' kind:
// selecting it records a skill name to inject into the NEXT send (the main
// process prepends the SKILL.md body). The composer surfaces these both in the
// "+" menu and via a "/"-triggered filterable popover (two groups: Commands +
// Skills).

import type { JcodeSkill } from '../../../../shared/jcode-chat-types'

export type SlashCommand =
  | { id: string; label: string; hint: string; kind: 'template'; template: string }
  | { id: string; label: string; hint: string; kind: 'action'; action: 'clear' | 'resume' }
  | {
      id: string
      label: string
      hint: string
      kind: 'skill'
      /** Skill name passed to jcodeChat.send so main injects its body. */
      skillName: string
      /** Source for the group sub-label (project/global/plugin). */
      source: JcodeSkill['source']
    }

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    id: 'explain',
    label: '/explain',
    hint: 'Explain this code',
    kind: 'template',
    template: 'Explain how the code in this project works, focusing on '
  },
  {
    id: 'review',
    label: '/review',
    hint: 'Review for bugs',
    kind: 'template',
    template: 'Review the current changes for bugs, edge cases, and correctness issues.'
  },
  {
    id: 'tests',
    label: '/tests',
    hint: 'Write tests',
    kind: 'template',
    template: 'Write tests covering '
  },
  {
    id: 'summarize',
    label: '/summarize',
    hint: 'Summarize',
    kind: 'template',
    template: 'Summarize '
  },
  { id: 'clear', label: '/clear', hint: 'Start a new chat', kind: 'action', action: 'clear' },
  { id: 'resume', label: '/resume', hint: 'Reopen last chat', kind: 'action', action: 'resume' }
]

/** Truncate a long skill description to a single menu-friendly line. */
function truncate(text: string, max = 80): string {
  const clean = text.trim()
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}

/** Map a discovered skill to a slash-menu command. */
export function skillToCommand(skill: JcodeSkill): SlashCommand {
  return {
    id: `skill:${skill.name}`,
    label: `/${skill.name}`,
    hint: truncate(skill.description) || skill.source,
    kind: 'skill',
    skillName: skill.name,
    source: skill.source
  }
}

/** Two filtered groups for a "/query" (query is the text after the slash,
 *  lowercased). The orca quick-commands always show; skills are matched the same
 *  way. The (potentially large) global skill list is gated behind >=1 typed char
 *  so an empty "/" doesn't dump ~100 rows — project skills always show. */
export function filterSlashGroups(
  query: string,
  skills: JcodeSkill[]
): { commands: SlashCommand[]; skills: SlashCommand[] } {
  const matchesQuery = (label: string, hint: string): boolean =>
    label.slice(1).toLowerCase().startsWith(query) || hint.toLowerCase().includes(query)

  const commands = SLASH_COMMANDS.filter((command) => matchesQuery(command.label, command.hint))

  const skillCommands = skills
    .filter((skill) => query.length > 0 || skill.source === 'project')
    .map(skillToCommand)
    .filter((command) => matchesQuery(command.label, command.hint))

  return { commands, skills: skillCommands }
}

/** Legacy single-list filter kept for the "+" menu callers. */
export function filterSlashCommands(query: string): SlashCommand[] {
  return SLASH_COMMANDS.filter(
    (command) =>
      command.label.slice(1).toLowerCase().startsWith(query) ||
      command.hint.toLowerCase().includes(query)
  )
}
