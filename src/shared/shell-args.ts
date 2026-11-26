/** A command line's words, with single or double quotes keeping spaces in one word. */
export function parseShellArgs(input: string): string[] {
  const args: string[] = []
  let current = ''
  let inDouble = false
  let inSingle = false
  // A closed empty quote is still a word, so later arguments keep their positions.
  let wordStarted = false

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (ch === '"' && !inSingle) {
      if (inDouble) {
        wordStarted = true
      }
      inDouble = !inDouble
    } else if (ch === "'" && !inDouble) {
      if (inSingle) {
        wordStarted = true
      }
      inSingle = !inSingle
    } else if (ch === ' ' && !inDouble && !inSingle) {
      if (wordStarted) {
        args.push(current)
        current = ''
        wordStarted = false
      }
    } else {
      current += ch
      wordStarted = true
    }
  }
  if (wordStarted) {
    args.push(current)
  }
  return args
}
