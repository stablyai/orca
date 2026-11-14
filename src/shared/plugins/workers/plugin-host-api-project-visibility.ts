import { z } from 'zod'
import { PLUGIN_HOST_ID_MAX_LENGTH } from './plugin-host-api-workspace-methods'
import { spec, WORKER_ONLY } from './plugin-host-method-spec'

/** Host API 1.9: hide a project from Orca's sidebar, or show it again, as its project menu does. */

const projectSetHiddenParams = z.strictObject({
  /** The project, as `project.list` gives its id. */
  projectId: z.string().min(1).max(PLUGIN_HOST_ID_MAX_LENGTH),
  /** The project's host, as `project.list` gives it; needed only when two hosts have it. */
  hostId: z.string().min(1).max(PLUGIN_HOST_ID_MAX_LENGTH).optional(),
  /** True hides it; false shows it again. */
  hidden: z.boolean()
})
const projectSetHiddenResult = z.object({
  /** The host whose copy changed, as `project.list` names it. */
  hostId: z.string().min(1).max(PLUGIN_HOST_ID_MAX_LENGTH),
  /** Whether that copy is hidden now. */
  hidden: z.boolean()
})

export const PLUGIN_PROJECT_VISIBILITY_API = {
  'project.setHidden': spec({
    summary:
      "Hides a project from Orca's sidebar, or shows it again, as Hide Project in its menu does. View-only: its workspaces, terminals, agents and automations keep running, `workspace.list` still lists its workspaces, `project.list` marks it `hidden`, and Orca's Hidden projects list can show it again. It changes one host's copy of the project; on a paired Orca server it hides the project for everyone connected.",
    since: 9,
    scope: 'any-workspace',
    capability: 'workspace:write',
    mutation: true,
    surfaces: WORKER_ONLY,
    params: projectSetHiddenParams,
    result: projectSetHiddenResult
  })
}
