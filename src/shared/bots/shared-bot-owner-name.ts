/** The name an invite calls the person who shared the agent by: their first name. */
export function ownerShortName(ownerName: string): string {
  return ownerName.trim().split(/\s+/)[0] || ownerName
}

const OWNER_SLOT = '⁣owner⁣'

/** A translated line around the owner's name, so the name alone can shorten: `line` is the line
 *  with `{{owner}}` given as the slot this passes it. */
export function aroundOwner(line: (owner: string) => string): { before: string; after: string } {
  const [before = '', after = ''] = line(OWNER_SLOT).split(OWNER_SLOT)
  return { before, after }
}
