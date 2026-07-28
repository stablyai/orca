import { z } from 'zod'
import {
  TERMINAL_COLOR_KEYS,
  hasUsableTerminalThemeColors,
  normalizeTerminalColorOverrides
} from '../terminal-custom-themes'
import type { TerminalColorOverrides } from '../types'

const pluginTerminalThemeArtifactSchema = z
  .object({
    schemaVersion: z.literal(1),
    mode: z.enum(['dark', 'light', 'unknown']).default('unknown'),
    terminal: z.record(z.string(), z.string()).superRefine((colors, ctx) => {
      for (const key of Object.keys(colors)) {
        if (!(TERMINAL_COLOR_KEYS as readonly string[]).includes(key)) {
          ctx.addIssue({ code: 'custom', path: [key], message: 'unknown terminal color slot' })
        }
      }
    })
  })
  .strict()

export type PluginTerminalThemeRegistration = {
  id: `plugin:${string}`
  pluginKey: string
  label: string
  mode: 'dark' | 'light' | 'unknown'
  terminal: TerminalColorOverrides
}

export function parsePluginTerminalThemeArtifact(raw: string): {
  mode: PluginTerminalThemeRegistration['mode']
  terminal: TerminalColorOverrides
} {
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
