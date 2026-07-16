export function isMeaningfulOpenCodeTerminalTitle(title: string | null | undefined): boolean {
  // Why: bare OpenCode labels are status/identity; `OC | …` carries native session identity.
  return /^OC\s*\|\s*\S/u.test(title?.trim() ?? '')
}
