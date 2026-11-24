import { z } from 'zod'

/** Strict state behind ui.set’s field catch: a future key drops the whole state while reporting success.
 * Only add cross-version state here; per-device view preferences belong in local storage. */
export const TaskResumeState = z
  .object({
    githubMode: z.enum(['items', 'project']).optional(),
    githubItemsPreset: z.string().nullable().optional(),
    githubItemsQuery: z.string().optional(),
    githubProjectHiddenFieldIdsByView: z.record(z.string(), z.array(z.string())).optional(),
    linearMode: z.enum(['issues', 'projects', 'views', 'in-orca']).optional(),
    linearPreset: z.enum(['assigned', 'created', 'all', 'completed']).optional(),
    linearQuery: z.string().optional(),
    linearContext: z
      .object({
        kind: z.enum(['project', 'view']),
        id: z.string(),
        workspaceId: z.string(),
        model: z.enum(['issue', 'project']).optional()
      })
      .strict()
      .optional(),
    jiraPreset: z.enum(['assigned', 'reported', 'all', 'done']).optional(),
    jiraQuery: z.string().optional()
  })
  .strict()
