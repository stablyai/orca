import { z } from 'zod'
import { isQualifiedPluginKey } from './plugin-tab-key'
import { pluginIdSchema } from './plugin-manifest-fields'
import { pluginTaskItemSchema, pluginTaskLinkMetadataSchema } from './plugin-task-source'

/**
 * A workspace's link back to the plugin task it was started from. Stored in
 * worktree metadata so the sidebar card can open the task and the task list
 * can show which workspaces already work on it.
 */
export const linkedPluginTaskSchema = z
  .object({
    pluginKey: z.string().max(512).refine(isQualifiedPluginKey, 'invalid qualified plugin key'),
    sourceId: pluginIdSchema,
    itemId: pluginTaskItemSchema.shape.id,
    title: pluginTaskItemSchema.shape.title,
    sourceTitle: z.string().min(1).max(64),
    url: pluginTaskItemSchema.shape.url,
    metadata: pluginTaskLinkMetadataSchema.optional()
  })
  .strict()

export type LinkedPluginTask = z.infer<typeof linkedPluginTaskSchema>

/** Persisted metadata is untrusted on load and write; invalid links become null. */
export function normalizeLinkedPluginTask(value: unknown): LinkedPluginTask | null {
  const parsed = linkedPluginTaskSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

export function isLinkedToPluginTask(
  link: LinkedPluginTask | null | undefined,
  target: { pluginKey: string; sourceId: string; itemId: string }
): boolean {
  return Boolean(
    link &&
    link.pluginKey === target.pluginKey &&
    link.sourceId === target.sourceId &&
    link.itemId === target.itemId
  )
}
