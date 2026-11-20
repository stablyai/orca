import { z } from 'zod'
import { pluginCommandIdSchema } from '../manifest/plugin-manifest-fields'

export const PLUGIN_NOTIFICATION_CLICK_URL_MAX_LENGTH = 8192

/** Narrower than `shell.openExternal`: a click fills in no draft, so `mailto:` is refused too. */
export function isPluginNotificationClickUrl(url: string): boolean {
  try {
    return ['http:', 'https:'].includes(new URL(url).protocol)
  } catch {
    return false
  }
}

/** What a click on the notification does: open an http(s) URL, or run one of the plugin's own commands. */
const notificationClickAction = z.union([
  z.strictObject({
    url: z
      .string()
      .min(1)
      .max(PLUGIN_NOTIFICATION_CLICK_URL_MAX_LENGTH)
      .refine(isPluginNotificationClickUrl, 'url must be an http: or https: URL')
  }),
  z.strictObject({ command: pluginCommandIdSchema })
])
export type PluginNotificationClickAction = z.infer<typeof notificationClickAction>

export const notificationsShowParams = z.strictObject({
  title: z.string().min(1).max(120),
  body: z.string().max(1000).optional(),
  onClick: notificationClickAction.optional()
})
export const notificationsShowResult = z.object({ delivered: z.boolean() })
