// Journal items only bots write: a saved automation, an added tool, a wait that ended, a run that
// couldn't start, and an item note.

import * as z from 'zod'

const AutomationRef = z.object({ id: z.string().min(1), name: z.string() })

/** Appended after the shared item bodies; storage reads the known bodies by position. */
export const BOT_JOURNAL_ITEM_BODIES = [
  z.object({
    kind: z.literal('automation-saved'),
    // Open like `sentAs`: a change a newer host writes still draws as a saved automation.
    change: z.string().min(1),
    automation: AutomationRef
  }),
  z.object({
    kind: z.literal('tool-added'),
    botId: z.string().min(1),
    tool: z.object({ name: z.string().min(1), detail: z.string(), remote: z.boolean() }),
    addedAt: z.number().finite()
  }),
  z.object({
    kind: z.literal('wait-ended'),
    automation: AutomationRef,
    // Open like `change`: an ending a newer host writes still draws as a wait that ended.
    ending: z.object({ kind: z.string().min(1), at: z.number().finite() })
  }),
  z.object({
    kind: z.literal('automation-run-not-started'),
    run: z.object({ runId: z.string().min(1), automation: AutomationRef }),
    error: z.string(),
    text: z.string(),
    at: z.number().finite()
  }),
  z.object({
    kind: z.literal('bot-item-note'),
    noteId: z.string().min(1),
    // Open like `change`: a newer host's author or event still draws.
    by: z.union([
      z.string().min(1),
      z.object({
        kind: z.literal('chat'),
        chatId: z.string().min(1),
        title: z.string().nullable(),
        home: z.literal(true).optional()
      })
    ]),
    entries: z.array(
      z.object({
        uid: z.string().min(1),
        number: z.number().int(),
        title: z.string(),
        status: z.string().min(1),
        event: z.string().min(1)
      })
    ),
    closedChat: z.object({ chatId: z.string().min(1), title: z.string().nullable() }).optional()
  })
] as const
