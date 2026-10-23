import { z } from 'zod'

/**
 * What a client window shows its user, sent by `sidebarInputs.reportView` to each host that owns
 * one of those workspaces: the workspaces on screen and their tabs on screen. Each report replaces
 * the client's last one; an empty one means the window is hidden or unfocused.
 */
export const ClientWorkspaceViewParams = z.object({
  workspaceIds: z.array(z.string().min(1).max(1024)).max(64),
  tabIds: z.array(z.string().min(1).max(1024)).max(256),
  /** How long the user stays present without new input; null where presence is not tracked. */
  presentForMs: z.number().int().nonnegative().nullable()
})

export type ClientWorkspaceView = z.infer<typeof ClientWorkspaceViewParams>
