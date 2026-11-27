import { z } from 'zod'

/** What a client sends to run a workspace command on one workspace. Main never forwards it: the
 *  id embeds the folder path. */
export const pluginWorkspaceCommandRequestSchema = z.strictObject({
  worktreeId: z
    .string()
    .min(1)
    .max(32 * 1024),
  /** The workspace subfolder picked from a badge's list. Main checks it, so a bad one fails. */
  folder: z.string().max(1024).optional()
})

export type PluginWorkspaceCommandRequest = z.infer<typeof pluginWorkspaceCommandRequestSchema>

/** The `args` a worker command with `when: "workspace"` receives when the user runs it on a
 *  workspace, if the plugin was granted `workspace:read`. */
export type PluginWorkspaceCommandArgs = {
  worktree: {
    /** Absolute folder path on the host `host` names. */
    path: string
    displayName: string
    /** Empty for folder workspaces. */
    branch: string
    host: 'local' | 'ssh'
  }
  /** The subfolder the user picked from a badge's list; absent for the workspace folder. */
  folder?: {
    /** Absolute path on the workspace's host. */
    path: string
    /** Relative to the workspace folder, with `/` separators. */
    relativePath: string
  }
}

/** A worker command may answer `{ message }`; Orca shows it to the user. */
export const pluginCommandResultMessageSchema = z.object({
  message: z.string().min(1).max(512)
})
