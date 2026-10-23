/** Replaces the provider options or sets the permission mode, never both, so neither write
 *  touches the other. */
export type AgentSessionOptionsReplacement = {
  sessionId: string
  fence: number
  now: number
} & ({ options: Readonly<Record<string, string>> } | { permissionMode: string })
