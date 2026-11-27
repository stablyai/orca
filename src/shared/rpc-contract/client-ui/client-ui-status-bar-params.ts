import * as z from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'

export const StatusBarItem = lazyZodSchema(() =>
  z.enum([
    'claude',
    'codex',
    'opencode-go',
    'kimi',
    'minimax',
    'grok',
    'cursor',
    'zcode',
    'muse',
    'ssh',
    'resource-usage',
    'ports',
    'git-blame'
  ])
)

// Older clients still list the removed Gemini CLI and Antigravity usage items; drop them instead of rejecting their list.
export const StatusBarItems = lazyZodSchema(() =>
  z
    .array(z.union([StatusBarItem, z.literal('gemini'), z.literal('antigravity')]))
    .transform((items) =>
      items.filter(
        (item): item is z.infer<typeof StatusBarItem> => item !== 'gemini' && item !== 'antigravity'
      )
    )
)
