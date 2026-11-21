// The item salvage asks with: one line on why, the lines as written (each shown without its leading
// dash, and any later line that may replace it under it), and quick replies. A line that may be
// replaced is left out of the recommended reply, so one tap never brings back a reversed decision.
import type { BotItemAsk } from './bot-item-ask'

export const SALVAGE_KEEP_ALL = 'Keep all'
export const SALVAGE_KEEP_NONE = 'Keep none'
const LATER = '↳ Later:'

export type SalvageOffered = { line: string; month: string; replacedBy: string | null }

/** A line as plain text in the item's Markdown: its list dash dropped for display (the record and
 *  any restore keep it), and every Markdown mark escaped so the words show as written. */
export function salvageShownLine(line: string): string {
  return line.replace(/^\s*[-*+]\s+/, '').replace(/[\\`*_[\]<>|~#!]/g, '\\$&')
}

export function salvageProposalText(offered: readonly SalvageOffered[]): {
  title: string
  ask: BotItemAsk
} {
  const count = offered.length
  const safe = offered.flatMap(({ replacedBy }, index) => (replacedBy ? [] : [index + 1]))
  const someReplaced = safe.length < count
  const lines = offered.flatMap(({ line, replacedBy }, index) => [
    `${index + 1}. ${salvageShownLine(line)}`,
    // Italic, under its line: secondary to the line, but never cut off.
    ...(replacedBy ? [`   *${LATER} ${salvageShownLine(replacedBy)}*`] : [])
  ])
  // With a line that may be replaced, the one-tap keep is the rest ("Keep 1, 3"), recommended;
  // the replaced line comes back only when its number is typed.
  const keep = !someReplaced
    ? [SALVAGE_KEEP_ALL]
    : safe.length > 0
      ? [`Keep ${safe.join(', ')}`]
      : []
  const options = [...keep, SALVAGE_KEEP_NONE].map((label) => ({ label }))
  return {
    title: count === 1 ? 'Keep 1 line in memory?' : `Keep ${count} lines in memory?`,
    ask: {
      context: [
        "Tidy-up moved these lines from MEMORY.md to the journal. They read like your decisions, in the bot's own words. Nothing changes until you answer; you can also type the numbers to keep.",
        '',
        ...lines
      ].join('\n'),
      questions: [
        {
          prompt: 'Which lines to keep?',
          options,
          ...(someReplaced && keep.length > 0 ? { recommended: 0 } : {})
        }
      ]
    }
  }
}

export const SALVAGE_REASK: BotItemAsk = {
  context: `That answer couldn't be read, so nothing was kept. Answer ${SALVAGE_KEEP_ALL}, ${SALVAGE_KEEP_NONE}, or the numbers to keep, like "1, 3".`,
  questions: [
    {
      prompt: 'Which lines to keep?',
      options: [{ label: SALVAGE_KEEP_ALL }, { label: SALVAGE_KEEP_NONE }]
    }
  ]
}

export const SALVAGE_NOTES = {
  kept: (kept: number, unrestorable: number) =>
    unrestorable === 0
      ? `Kept ${kept} in memory.`
      : `Kept ${kept} in memory; ${unrestorable} could not be put back as written.`,
  unread: "The answer couldn't be read twice, so nothing was kept.",
  expired: 'No answer in 14 days. Will ask again later.'
} as const
