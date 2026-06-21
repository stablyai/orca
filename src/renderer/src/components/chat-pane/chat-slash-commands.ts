// orca-side "/" quick commands for the jcode chat composer. These are
// ORCA-provided prompt templates + actions, NOT jcode skills (jcode headless has
// none). A 'template' inserts/replaces the draft text; an 'action' runs a
// composer-level callback (e.g. start a new chat). The composer surfaces these
// both in the "+" menu and via a "/"-triggered filterable popover.

export type SlashCommand =
  | { id: string; label: string; hint: string; kind: 'template'; template: string }
  | { id: string; label: string; hint: string; kind: 'action'; action: 'clear' | 'resume' }

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

/** Filter the slash commands for a "/query" (query is the text after the slash,
 *  lowercased). Matches on the command token prefix or a substring of the hint. */
export function filterSlashCommands(query: string): SlashCommand[] {
  return SLASH_COMMANDS.filter(
    (command) =>
      command.label.slice(1).toLowerCase().startsWith(query) ||
      command.hint.toLowerCase().includes(query)
  )
}
