/** Replaces the provider options or sets the permission mode, never both, so neither write
 *  touches the other. */
export type AgentSessionOptionsReplacement = {
  sessionId: string
  fence: number
  now: number
} & (
  | {
      options: Readonly<Record<string, string>>
      /** Absent keeps the saved default; null leaves it, so the chat's own picks decide. */
      defaultModelOptions?: Readonly<Record<string, string>> | null
    }
  | { permissionMode: string }
)
