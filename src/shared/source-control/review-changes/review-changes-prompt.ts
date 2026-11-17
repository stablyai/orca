/** Orca's built-in prompt for "Review changes with AI": an agent reviews the workspace's
 *  changes without editing them and records each finding as a review note through the CLI. */
export function buildReviewChangesPrompt({
  worktreePath,
  baseRef
}: {
  worktreePath: string
  baseRef: string | null
}): string {
  const scope = baseRef
    ? [
        `Review the changes on this branch against ${baseRef}, plus any uncommitted work:`,
        `- committed: git diff ${baseRef}...HEAD`,
        '- uncommitted: git diff HEAD',
        '- new files: git ls-files --others --exclude-standard'
      ]
    : [
        'Review the uncommitted changes in this workspace:',
        '- git diff HEAD',
        '- new files: git ls-files --others --exclude-standard'
      ]
  return [
    `You are reviewing code in the workspace at ${worktreePath}. Run commands from that directory.`,
    'This is a read-only review: do not edit, stage, commit, push or format any file.',
    '',
    ...scope,
    '',
    'Report only real problems: bugs, regressions, security issues, data loss, unhandled edge cases, and dead or unfinished code. Read the surrounding code when you need context. Skip praise, style nits and summaries of what the code does. If you are unsure, say so in the note rather than guessing.',
    '',
    'Record each finding as an Orca review note on the line where the problem is, in the current version of the file. One note per finding:',
    '  orca worktree notes add --file <path relative to the workspace root> --line <n> [--start-line <n>] --body "<text>"',
    'For a multi-line body, pass --body-file - and write the text to stdin.',
    'Start the body with the severity and a short title, then explain the problem and how to fix it, for example:',
    '  [major] Division by zero is not handled',
    '  div() returns Infinity when b is 0. Throw or return an error instead.',
    'Severity: [critical] breaks the build, security or data loss; [major] a likely bug or wrong logic; [minor] a small improvement worth making.',
    'A deleted line cannot hold a note; put it on the nearest remaining line. Run orca worktree notes list first and do not repeat a note that is already there.',
    '',
    'When you are done, reply with one line: how many notes you added, or that you found no problems.'
  ].join('\n')
}
