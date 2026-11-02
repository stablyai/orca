import { z } from 'zod'

export const PrepareCodexForWslPaneParams = z
  .object({
    codexHome: z.string().max(4_096),
    orcaCodexHome: z.string().max(4_096),
    wslDistro: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .regex(/^[^\\/\r\n]+$/)
  })
  .strict()

const savedRestoreToken = z.string().regex(/^[0-9a-f]{32}$/)
const savedRestorePath = z.string().max(4_096)

/** An Orca agent function's in-pane restore check, then its report that it ran the fresh answer. */
export const SavedRestoreCheckParams = z.discriminatedUnion('phase', [
  z
    .object({
      phase: z.literal('check'),
      token: savedRestoreToken,
      agent: z.string().max(64),
      args: z.array(z.string().max(32_768)).max(512),
      roots: z
        .object({
          HOME: savedRestorePath,
          USERPROFILE: savedRestorePath,
          CLAUDE_CONFIG_DIR: savedRestorePath,
          CODEX_HOME: savedRestorePath,
          XDG_DATA_HOME: savedRestorePath,
          OPENCODE_DB: savedRestorePath
        })
        .partial()
        .strict(),
      cwd: savedRestorePath,
      remainingMs: z.number().int().min(0).max(60_000)
    })
    .strict(),
  z.object({ phase: z.literal('dispatched'), token: savedRestoreToken }).strict()
])
