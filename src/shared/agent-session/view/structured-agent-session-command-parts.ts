export function structuredComposerCommandParts(
  text: string,
  multilineCommands: readonly { name: string }[]
): { name: string; argument: string } | null {
  if (!text.startsWith('/')) {
    return null
  }
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text.trimEnd())
  if (!match) {
    return null
  }
  const name = match[1]!.toLowerCase()
  const argument = match[2]?.trim() ?? ''
  // Other commands take one line; a longer message that starts with their name is for the agent.
  return /[\n\r\u2028\u2029]/.test(argument) &&
    name !== 'btw' &&
    !multilineCommands.some((entry) => entry.name === name)
    ? null
    : { name, argument }
}
