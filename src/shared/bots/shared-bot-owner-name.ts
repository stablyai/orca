/** The name an invite calls the person who shared the agent by: their first name. */
export function ownerShortName(ownerName: string): string {
  return ownerName.trim().split(/\s+/)[0] || ownerName
}
