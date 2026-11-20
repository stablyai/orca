import { z } from 'zod'
import { PLUGIN_HOST_ID_MAX_LENGTH } from './plugin-host-api-workspace-methods'
import { spec, WORKER_ONLY } from './plugin-host-method-spec'

/** Host API 1.11: list and add SSH hosts, connect them, and add projects on any host. */

export const PLUGIN_HOST_LIST_LIMIT = 500
const LABEL_MAX = 200
const PATH_MAX = 4096
const hostId = z.string().min(1).max(PLUGIN_HOST_ID_MAX_LENGTH)

const hostListResult = z.object({
  hosts: z
    .array(
      z.object({
        /** `local`, or `ssh:<target>` as `project.list` and `workspace.list` name hosts. */
        hostId,
        kind: z.enum(['local', 'ssh']),
        /** The name Orca shows for it. */
        name: z.string().max(LABEL_MAX),
        /** Whether Orca is connected to it now; always true for `local`. */
        connected: z.boolean()
      })
    )
    .max(PLUGIN_HOST_LIST_LIMIT),
  truncated: z.boolean()
})

const hostAddSshTargetParams = z.strictObject({
  /** The name Orca shows for the host. */
  name: z.string().trim().min(1).max(LABEL_MAX),
  /** Host name, IP address or `ssh_config` Host alias; an alias picks up its settings there. */
  host: z.string().trim().min(1).max(512),
  /** Defaults to 22. */
  port: z.number().int().min(1).max(65_535).optional(),
  /** Defaults to what `ssh_config` or the system gives. */
  username: z.string().trim().max(LABEL_MAX).optional(),
  /** A command whose stdin and stdout carry the SSH connection, as ssh's ProxyCommand. */
  proxyCommand: z.string().trim().min(1).max(PATH_MAX).optional(),
  /** A private key file on this computer. */
  identityFile: z.string().trim().min(1).max(PATH_MAX).optional()
})
const hostAddSshTargetResult = z.object({
  /** The new host, as `host.list` names it. */
  hostId
})

const hostConnectParams = z.strictObject({
  /** An `ssh:` host, as `host.list` gives it. */
  hostId
})
const hostConnectResult = z.object({ connected: z.boolean() })

const projectAddParams = z.strictObject({
  /** Where the folder is: `local` (the default) or an `ssh:` host from `host.list`. */
  hostId: hostId.optional(),
  /** Absolute path of an existing folder on that host. */
  path: z.string().min(1).max(PATH_MAX),
  /** `git` (the default) needs a Git repository; `folder` takes any folder. */
  kind: z.enum(['git', 'folder']).optional(),
  /** The name Orca shows; defaults to the folder name. */
  name: z.string().trim().min(1).max(LABEL_MAX).optional()
})
const projectAddResult = z.object({
  /** The project, as `project.list` gives its id. */
  projectId: z.string().min(1).max(PLUGIN_HOST_ID_MAX_LENGTH),
  /** The host that holds it: `local`, or the `runtime:` host Orca runs on that SSH machine. */
  hostId,
  /** False when Orca already had this folder as a project. */
  created: z.boolean()
})

export const PLUGIN_HOSTS_API = {
  'host.list': spec({
    summary:
      'Lists this computer and the SSH hosts saved in Orca, with whether each is connected. Paired Orca servers are not listed.',
    since: 11,
    scope: 'any-workspace',
    capability: 'workspace:read',
    mutation: false,
    surfaces: WORKER_ONLY,
    params: z.strictObject({}).optional(),
    result: hostListResult
  }),
  'host.addSshTarget': spec({
    summary:
      'Saves an SSH host in Orca, as adding one in Settings does, and returns its id; it does not connect. Orca runs `proxyCommand` on this computer whenever it connects. The person can edit or remove the host in Settings like any other. Credentials are not stored: Orca asks for a password or passphrase when connecting, as it does for hosts added by hand.',
    since: 11,
    scope: 'any-workspace',
    capability: 'host:write',
    mutation: true,
    surfaces: WORKER_ONLY,
    params: hostAddSshTargetParams,
    result: hostAddSshTargetResult
  }),
  'host.connect': spec({
    summary:
      'Connects an SSH host, as clicking Connect does, and answers once it is ready; the first time, Orca sets up its server on that machine. Orca may ask the person for a password or passphrase. Fails with `action_failed` if the connection or setup fails.',
    since: 11,
    scope: 'any-workspace',
    capability: 'host:write',
    mutation: true,
    surfaces: WORKER_ONLY,
    params: hostConnectParams,
    result: hostConnectResult
  }),
  'project.add': spec({
    summary:
      'Adds an existing folder as a project, as Add Project does, on this computer or on a connected SSH host (connect it with `host.connect` first). A folder that is already a project answers its id with `created: false`. A `git` project that is not a Git repository fails with `action_failed`; pass `kind: "folder"` to add it anyway. Projects on an SSH host live on its Orca server, so `project.list` does not list them.',
    since: 11,
    scope: 'any-workspace',
    capability: 'workspace:write',
    mutation: true,
    surfaces: WORKER_ONLY,
    params: projectAddParams,
    result: projectAddResult
  })
}
