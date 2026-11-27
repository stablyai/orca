import { z } from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'

const worktreeCardStyleSchema = lazyZodSchema(() => z.enum(['classic', 'new']))

export const worktreeCardsIntroActionSchema = lazyZodSchema(() =>
  z
    .object({
      action: z.enum(['shown', 'flipped', 'kept', 'dismissed']),
      switch_position: worktreeCardStyleSchema
    })
    .strict()
)

export const worktreeCardStyleChangedSchema = lazyZodSchema(() =>
  z
    .object({
      style: worktreeCardStyleSchema,
      source: z.enum(['intro_note', 'options_menu', 'settings'])
    })
    .strict()
)
