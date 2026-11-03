import { z } from 'zod'
import { safePluginDisplayText } from '../manifest/plugin-display-text'
import { pluginFieldDoc, PLUGIN_PANEL_BRIDGE_SINCE } from '../manifest/plugin-schema-field-docs'

export const PLUGIN_SETTING_LIMIT = 64
export const PLUGIN_SETTING_ENUM_LIMIT = 64
export const PLUGIN_SETTING_STRING_MAX_LENGTH = 10_000

const SINCE = PLUGIN_PANEL_BRIDGE_SINCE
const scalar = z.union([
  z.string().max(PLUGIN_SETTING_STRING_MAX_LENGTH),
  z.number().finite(),
  z.boolean()
])

/**
 * One setting Orca shows under the plugin in Settings, described with a subset of JSON Schema.
 * Code reads it with `settings.get(key)` (the `settings:own` capability) and hears changes with
 * `settings.onDidChange`; an unset setting reads as its `default`.
 */
export const pluginSettingContributionSchema = z
  .strictObject({
    key: z
      .string()
      .regex(/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/, 'starts with a letter; letters, digits, . _ -')
      .meta(pluginFieldDoc('Key code reads and writes, unique in this plugin.', SINCE, ['apiUrl'])),
    title: safePluginDisplayText(z.string().min(1).max(120)).meta(
      pluginFieldDoc('Label shown in Settings.', SINCE, ['Server URL'])
    ),
    description: safePluginDisplayText(z.string().max(1000))
      .optional()
      .meta(pluginFieldDoc('Help text shown under the label.', SINCE)),
    type: z
      .enum(['string', 'number', 'integer', 'boolean'])
      .meta(pluginFieldDoc('JSON Schema type of the value.', SINCE, ['string'])),
    default: scalar
      .optional()
      .meta(pluginFieldDoc('Value read while the person has not set one.', SINCE)),
    enum: z
      .array(z.union([z.string().max(256), z.number().finite()]))
      .min(1)
      .max(PLUGIN_SETTING_ENUM_LIMIT)
      .optional()
      .meta(pluginFieldDoc('Allowed values; Settings shows a picker.', SINCE)),
    enumLabels: z
      .array(safePluginDisplayText(z.string().min(1).max(120)))
      .max(PLUGIN_SETTING_ENUM_LIMIT)
      .optional()
      .meta(pluginFieldDoc('Picker labels, one per `enum` value.', SINCE)),
    minimum: z.number().finite().optional().meta(pluginFieldDoc('Numbers: smallest value.', SINCE)),
    maximum: z.number().finite().optional().meta(pluginFieldDoc('Numbers: largest value.', SINCE)),
    maxLength: z
      .number()
      .int()
      .min(1)
      .max(PLUGIN_SETTING_STRING_MAX_LENGTH)
      .optional()
      .meta(pluginFieldDoc('Strings: most characters.', SINCE)),
    multiline: z
      .boolean()
      .optional()
      .meta(pluginFieldDoc('Strings: a multi-line text box.', SINCE)),
    placeholder: safePluginDisplayText(z.string().max(120))
      .optional()
      .meta(pluginFieldDoc('Strings and numbers: hint shown while empty.', SINCE))
  })
  .superRefine((setting, ctx) => {
    if (setting.enumLabels && setting.enumLabels.length !== setting.enum?.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['enumLabels'],
        message: 'needs one label per enum value'
      })
    }
    for (const [index, value] of (setting.enum ?? []).entries()) {
      if (pluginSettingValueIssue(setting, value, false)) {
        ctx.addIssue({ code: 'custom', path: ['enum', index], message: `is not a ${setting.type}` })
      }
    }
    const issue =
      setting.default === undefined ? null : pluginSettingValueIssue(setting, setting.default)
    if (issue) {
      ctx.addIssue({ code: 'custom', path: ['default'], message: issue })
    }
  })
  .meta({
    id: 'SettingContribution',
    description:
      'A setting shown under the plugin in Settings. Requires the `settings:own` capability, which is also how code reads it.'
  })

export type PluginSettingContribution = z.infer<typeof pluginSettingContributionSchema>

/** Why `value` cannot be this setting's value, or null when it can. */
export function pluginSettingValueIssue(
  setting: Pick<PluginSettingContribution, 'type' | 'enum' | 'minimum' | 'maximum' | 'maxLength'>,
  value: unknown,
  checkEnum = true
): string | null {
  const isNumber = typeof value === 'number' && Number.isFinite(value)
  const typeOk =
    setting.type === 'string'
      ? typeof value === 'string'
      : setting.type === 'boolean'
        ? typeof value === 'boolean'
        : isNumber && (setting.type === 'number' || Number.isInteger(value))
  if (!typeOk) {
    return `must be ${setting.type === 'integer' ? 'an integer' : `a ${setting.type}`}`
  }
  if (checkEnum && setting.enum && !setting.enum.some((allowed) => allowed === value)) {
    return `must be one of ${setting.enum.map((allowed) => JSON.stringify(allowed)).join(', ')}`
  }
  if (isNumber && setting.minimum !== undefined && value < setting.minimum) {
    return `must be at least ${setting.minimum}`
  }
  if (isNumber && setting.maximum !== undefined && value > setting.maximum) {
    return `must be at most ${setting.maximum}`
  }
  const maxLength = setting.maxLength ?? PLUGIN_SETTING_STRING_MAX_LENGTH
  if (typeof value === 'string' && value.length > maxLength) {
    return `must be at most ${maxLength} characters`
  }
  return null
}
