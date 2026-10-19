import { z } from 'zod'

/**
 * The sidebar inputs this host keeps in its own store and metadata, besides rows and activity.
 * Host ids use the ExecutionHostId spelling; workspace ids are the rows' own ids.
 */
export const DesktopSidebarFactsSchema = z.object({
  /** What the desktop window last saved as open; both null when nothing is. */
  desktopActive: z.object({
    hostId: z.string().nullable(),
    worktreeId: z.string().nullable()
  }),
  /** Pins in this host's metadata, git and folder; may name a workspace no longer listed, so read against rows. */
  pinnedWorkspaceIds: z.array(z.string()),
  /** This host's projects in the desktop's manual order. */
  repoOrder: z.array(z.object({ hostId: z.string(), repoId: z.string() })),
  /** The saved host-section order; hosts it omits follow in discovery order. */
  workspaceHostOrder: z.array(z.string()),
  // Statuses stay open strings so a status a newer host adds never fails an older reader's parse.
  /** Configured SSH targets by host id; status is null until a connection is attempted. */
  sshHosts: z.record(z.string(), z.object({ label: z.string(), status: z.string().nullable() })),
  /** WSL hosts by host id, where this host can run them. */
  wslHosts: z.record(z.string(), z.object({ distro: z.string(), state: z.string() })),
  /** The host the desktop has focused, where its sidebar files rows that name no owner. */
  focusedHostId: z.string().optional(),
  /** The user's own names for hosts, by host id. */
  hostLabels: z.record(z.string(), z.string()).optional(),
  /** "Also show pinned workspaces in their groups"; absent reads as off. */
  showPinnedInGroups: z.boolean().optional()
})

export type DesktopSidebarFacts = z.infer<typeof DesktopSidebarFactsSchema>
