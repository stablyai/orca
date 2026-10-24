import { z } from 'zod'
import {
  TERMINAL_COLOR_KEYS,
  hasUsableTerminalThemeColors,
  normalizeTerminalColorOverrides
} from '../terminal-custom-themes'
import { pluginContentIdSchema } from './plugin-theme-artifact'

const terminalColorKeySchema = z.enum(TERMINAL_COLOR_KEYS)
const terminalModeSchema = z.enum(['dark', 'light', 'unknown'])

const pluginTerminalThemeArtifactSchema = z
  .object({
    schemaVersion: z.literal(1),
    mode: terminalModeSchema.default('unknown'),
    terminal: z.partialRecord(terminalColorKeySchema, z.string())
  })
  .strict()

const pluginTerminalThemeRegistrationSchema = z.object({
  id: pluginContentIdSchema,
  pluginKey: z.string(),
  pluginName: z.string(),
  label: z.string(),
  mode: terminalModeSchema,
  terminal: z.partialRecord(terminalColorKeySchema, z.string())
})

export type PluginTerminalThemeRegistration = z.infer<typeof pluginTerminalThemeRegistrationSchema>

export function parsePluginTerminalThemeArtifact(
  raw: string
): Pick<PluginTerminalThemeRegistration, 'mode' | 'terminal'> {
  const parsed = pluginTerminalThemeArtifactSchema.parse(JSON.parse(raw))
  const terminal = normalizeTerminalColorOverrides(parsed.terminal)
  if (Object.keys(terminal).length !== Object.keys(parsed.terminal).length) {
    throw new Error('terminal theme contains an invalid color')
  }
  if (!hasUsableTerminalThemeColors(terminal)) {
    throw new Error('terminal theme requires background, foreground, and at least one ANSI color')
  }
  return { mode: parsed.mode, terminal }
}

export function isPluginTerminalThemeRegistration(
  value: unknown
): value is PluginTerminalThemeRegistration {
  const parsed = pluginTerminalThemeRegistrationSchema.safeParse(value)
  return (
    parsed.success &&
    hasUsableTerminalThemeColors(normalizeTerminalColorOverrides(parsed.data.terminal))
  )
}
