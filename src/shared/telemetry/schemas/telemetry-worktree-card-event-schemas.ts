import { z } from 'zod'

const worktreeCardStyleSchema = z.enum(['classic', 'new'])

// Intro note funnel for Classic users; kept over shown is the note's switch rate.
export const worktreeCardsIntroActionSchema = z
  .object({
    action: z.enum(['shown', 'flipped', 'kept', 'dismissed']),
    // Switch position after the action; on 'dismissed' it tells closing mid-preview apart from after flipping back.
    switch_position: worktreeCardStyleSchema
  })
  .strict()

// Every saved card-style change from any surface, so later switches back to Classic show up too.
export const worktreeCardStyleChangedSchema = z
  .object({
    style: worktreeCardStyleSchema,
    source: z.enum(['intro_note', 'options_menu', 'settings'])
  })
  .strict()
