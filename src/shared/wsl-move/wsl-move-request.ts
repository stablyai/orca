/** The move dialog's request as main accepts it from the renderer: anything else is refused. */
import { z } from 'zod'
import type { WslMovePreview, WslMoveRequest } from './wsl-move-driver-types'
import { WslMappedDrivesSchema } from './wsl-mapped-drive-paths'

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
    .optional(),
  mappedDrives: WslMappedDrivesSchema.optional(),
  previewMoving: z.object({ repoIds: Ids, folderWorkspaceIds: Ids }).optional()
})

/**
 * What a start sends back from the preview it starts: its drives and what it showed moving. With
 * no ready preview it names no rows, so main reports every row it leaves on a changed drive.
 */
export function wslMoveStartFieldsOf(
  preview: WslMovePreview | null
): Pick<WslMoveRequest, 'mappedDrives' | 'previewMoving'> {
  return preview?.outcome === 'ready'
    ? {
        mappedDrives: preview.mappedDrives ?? [],
        previewMoving: {
          repoIds: preview.repoIds,
          folderWorkspaceIds: preview.folderWorkspaceIds
        }
      }
    : { mappedDrives: [] }
}

export function parseWslMoveRequest(value: unknown): WslMoveRequest | null {
  const parsed = WslMoveRequestSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}
