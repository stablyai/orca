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
  '--radius',
  '--font-sans',
  '--font-mono'
] as const

/** Code editor syntax colors, painted on the root as `--syntax-<name>` and given to frames as
 *  `--orca-syntax-<name>`. Same growth rule as above. Apart from the allowlist because native
 *  chat visuals can pin a scheme the editor theme does not follow. */
export const PANEL_SYNTAX_COLORS = [
  'comment',
  'keyword',
  'string',
  'number',
  'function',
  'type',
  'variable',
  'constant',
  'operator',
  'tag',
  'attribute'
] as const

export type PanelSyntaxColor = (typeof PANEL_SYNTAX_COLORS)[number]

export const panelSyntaxToken = (name: PanelSyntaxColor): `--syntax-${PanelSyntaxColor}` =>
  `--syntax-${name}`

/** Every root token a panel or custom editor frame receives. */
export const PANEL_FRAME_TOKENS: readonly string[] = [
  ...PANEL_DESIGN_TOKEN_ALLOWLIST,
  ...PANEL_SYNTAX_COLORS.map(panelSyntaxToken)
]
