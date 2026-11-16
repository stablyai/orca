import { z } from 'zod'

const worktreeCardStyleSchema = z.enum(['classic', 'new'])

export const worktreeCardsIntroActionSchema = z
  .object({
    action: z.enum(['shown', 'flipped', 'kept', 'dismissed']),
    switch_position: worktreeCardStyleSchema
  })
  .strict()

export const worktreeCardStyleChangedSchema = z
  .object({
    style: worktreeCardStyleSchema,
    source: z.enum(['intro_note', 'options_menu', 'settings'])
  })
  .strict()
