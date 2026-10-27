/** The fence an edited code block goes back to the agent in: longer than any backtick run inside
 *  the text, so a block that itself holds a fence stays one block. */
export function fenceEditedCodeBlock(text: string, language: string | undefined): string {
  // A loop, not a spread into Math.max: a large block's many backtick runs could exceed the
  // function-argument limit and throw before the draft is updated.
  let longestRun = 0
  for (const run of text.match(/`+/g) ?? []) {
    longestRun = Math.max(longestRun, run.length)
  }
  const fence = '`'.repeat(Math.max(3, longestRun + 1))
  const body = text.endsWith('\n') ? text : `${text}\n`
  // A backtick fence's info string cannot hold a backtick, so such a label drops to unlabeled.
  const info = language && !language.includes('`') ? language : ''
  return `${fence}${info}\n${body}${fence}`
}
