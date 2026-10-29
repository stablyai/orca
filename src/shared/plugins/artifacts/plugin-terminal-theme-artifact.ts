import { z } from 'zod'
import {
  TERMINAL_COLOR_KEYS,
  hasUsableTerminalThemeColors,
  normalizeTerminalColorOverrides
} from '../../terminal-custom-themes'
import {
  pickKnownArtifactKeys,
  pluginContentIdSchema,
  type PluginArtifactStrictness
} from './plugin-theme-artifact'

const terminalColorKeySchema = z.enum(TERMINAL_COLOR_KEYS)
const terminalModeSchema = z.enum(['dark', 'light', 'unknown'])

const TERMINAL_COLOR_KEY_SET: ReadonlySet<string> = new Set(TERMINAL_COLOR_KEYS)

function pluginTerminalThemeArtifactSchema(strictness: PluginArtifactStrictness) {
  const terminal = z.partialRecord(terminalColorKeySchema, z.string())
  const fields = {
    schemaVersion: z.literal(1),
    mode: terminalModeSchema.default('unknown'),
    terminal:
      strictness === 'strict'
        ? terminal
        : z.preprocess(pickKnownArtifactKeys(TERMINAL_COLOR_KEY_SET), terminal)
  }
  return strictness === 'strict' ? z.strictObject(fields) : z.object(fields)
}

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
  raw: string,
  strictness: PluginArtifactStrictness = 'tolerant'
): Pick<PluginTerminalThemeRegistration, 'mode' | 'terminal'> {
  const parsed = pluginTerminalThemeArtifactSchema(strictness).parse(JSON.parse(raw))
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
