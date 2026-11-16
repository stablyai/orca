/** The move dialog's request as main accepts it from the renderer: anything else is refused. */
import { z } from 'zod'
import type { WslMoveRequest } from './wsl-move-driver-types'

const Ids = z.array(z.string().min(1).max(1_024)).max(10_000)

const WslMoveRequestSchema = z.object({
  // A WSL distro name: what `wsl.exe -l` lists, never a path.
  distro: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[^\\/:*?"<>|\0]+$/),
  repoIds: Ids.optional(),
  folderWorkspaceIds: Ids.optional(),
  sleptPanes: z
    .array(
      z.object({ paneKey: z.string().min(1).max(1_024), sessionId: z.string().min(1).max(1_024) })
    )
    .max(10_000)
    .optional()
})

export function parseWslMoveRequest(value: unknown): WslMoveRequest | null {
  const parsed = WslMoveRequestSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}
