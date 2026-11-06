/** Curated design-token subset injected into panel documents as `--orca-<name>`. Deliberately
 *  NOT all of main.css (~257 custom properties): freezing every token as
 *  public API would lock future refactors. Grow additively; renaming or
 *  dropping an entry here is a plugin-facing breaking change. */
export const PANEL_DESIGN_TOKEN_ALLOWLIST = [
  '--background',
  '--foreground',
  '--card',
  '--card-foreground',
  '--popover',
  '--popover-foreground',
  '--primary',
  '--primary-foreground',
  '--secondary',
  '--secondary-foreground',
  '--muted',
  '--muted-foreground',
  '--accent',
  '--accent-foreground',
  '--destructive',
  '--destructive-foreground',
  '--border',
  '--input',
  '--ring',
  '--radius'
] as const
