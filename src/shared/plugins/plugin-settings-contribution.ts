import { z } from 'zod'

/**
 * `contributes.settings`: plugin options the user edits in Settings > Plugins.
 * Values land in the plugin's own settings store (`settings.get` in the worker,
 * which needs `settings:own`); only user-set values are stored, so the plugin
 * applies its declared defaults itself.
 */

export const PLUGIN_SETTING_LIMIT = 32
export const PLUGIN_SETTING_STRING_MAX_CHARS = 4096

const settingKeySchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z][A-Za-z0-9_.-]*$/, 'must start with a letter and use letters, digits, _ . -')

export const pluginSettingContributionSchema = z
  .object({
    key: settingKeySchema,
    title: z.string().min(1).max(64),
    description: z.string().min(1).max(512).optional(),
    type: z.enum(['string', 'boolean', 'enum']),
    default: z.union([z.string().max(PLUGIN_SETTING_STRING_MAX_CHARS), z.boolean()]).optional(),
    placeholder: z.string().min(1).max(256).optional(),
    /** String settings only: edit in a multi-line field. */
    multiline: z.boolean().optional(),
    options: z
      .array(z.object({ value: z.string().max(256), label: z.string().min(1).max(128) }).strict())
      .min(1)
      .max(32)
      .optional()
  })
  .strict()
  .superRefine((setting, ctx) => {
    const issue = (message: string, path: string): void =>
      ctx.addIssue({ code: 'custom', path: [path], message })
    if (setting.type === 'enum') {
      if (!setting.options) {
        issue('required for enum settings', 'options')
      } else if (
        setting.default !== undefined &&
        !setting.options.some((option) => option.value === setting.default)
      ) {
        issue('must be one of the options', 'default')
      }
    } else if (setting.options) {
      issue('only enum settings take options', 'options')
    }
    if (setting.default !== undefined) {
      const expected = setting.type === 'boolean' ? 'boolean' : 'string'
      if (typeof setting.default !== expected) {
        issue(`must be a ${expected}`, 'default')
      }
    }
    if (setting.type !== 'string' && (setting.placeholder || setting.multiline)) {
      issue('placeholder and multiline apply to string settings only', 'type')
    }
  })

export type PluginSettingContribution = z.infer<typeof pluginSettingContributionSchema>

export type PluginSettingValue = string | boolean

/** Validates a user-entered value against its declaration; null when it does not fit. */
export function parsePluginSettingValue(
  setting: PluginSettingContribution,
  value: unknown
): PluginSettingValue | null {
  if (setting.type === 'boolean') {
    return typeof value === 'boolean' ? value : null
  }
  if (typeof value !== 'string' || value.length > PLUGIN_SETTING_STRING_MAX_CHARS) {
    return null
  }
  if (setting.type === 'enum' && !setting.options?.some((option) => option.value === value)) {
    return null
  }
  return value
}
