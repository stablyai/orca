// Teammate profiles and Pokes wire types (sandbox control plane /v1/team/members/:id/profile,
// /v1/team/members/:id/poke, /v1/team/pokes). Mirrors cloud/apps/sandbox-control/src/team-presence.ts.
import { z } from 'zod'
import { CloudWorkspaceSchema } from './cloud-workspaces-wire'

/** 26 full weeks, the window the profile heatmap covers (today included). */
export const TEAMMATE_HEATMAP_DAYS = 182
/** Most recent workspaces a profile lists (only ones the viewer can already see). */
export const TEAMMATE_RECENT_WORKSPACES = 5
/** One poke per sender → teammate pair per minute. */
export const POKE_PAIR_COOLDOWN_MS = 60_000
/** Pokes one person may send per rolling hour, across all teammates. */
export const POKE_SENDER_HOURLY_LIMIT = 20
/** A poke not seen within a day is dropped instead of surfacing stale on the next launch. */
export const POKE_INBOX_TTL_MS = 24 * 60 * 60_000

/** Teammates get a 0–4 intensity per day; exact amounts are only ever sent to the person themself. */
export const TeammateUsageLevelSchema = z.number().int().min(0).max(4)

export const TeammateUsageSchema = z.object({
  /** Local calendar date (YYYY-MM-DD) of `levels[0]`; one entry per day through today. */
  start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  levels: z.array(TeammateUsageLevelSchema).max(400),
  /** Days with any usage in the window. */
  activeDays: z.number().int().min(0),
  /** Self only: per-day sandbox time (ms) and spend (USD micros), aligned with `levels`. */
  own: z
    .object({
      computeMs: z.array(z.number().min(0)).max(400),
      usdMicros: z.array(z.number().min(0)).max(400)
    })
    .nullable()
})

export const TeammateProfileSchema = z.object({
  userId: z.string().min(1).max(128),
  self: z.boolean(),
  /** The member's own token name, when the control plane has seen one; the roster wins over it. */
  name: z.string().max(80).nullable(),
  /** null: the teammate hasn't turned on "Pokes and activity", so their activity isn't shared. */
  usage: TeammateUsageSchema.nullable(),
  recentWorkspaces: z.array(CloudWorkspaceSchema).max(20),
  pokes: z.object({
    /** The viewer has Pokes turned on. */
    enabled: z.boolean(),
    /** The teammate has it on (it also shares their activity); null on your own profile. */
    teammateEnabled: z.boolean().nullable()
  })
})

export const TeammateProfileResponseSchema = z.object({ profile: TeammateProfileSchema })

export const PokeSchema = z.object({
  id: z.string().regex(/^pok_[0-9a-f]{24}$/),
  fromUserId: z.string().min(1).max(128),
  fromName: z.string().max(80).nullable(),
  at: z.number()
})

export const PokeInboxSchema = z.object({
  enabled: z.boolean(),
  pokes: z.array(PokeSchema).max(50)
})

export const PokeSettingsSchema = z.object({ enabled: z.boolean() })

export const PokeSentSchema = z.object({ poke: z.object({ id: z.string(), at: z.number() }) })

export type TeammateUsage = z.infer<typeof TeammateUsageSchema>
export type TeammateProfile = z.infer<typeof TeammateProfileSchema>
export type Poke = z.infer<typeof PokeSchema>
export type PokeInbox = z.infer<typeof PokeInboxSchema>

/** Why a poke didn't go out; the renderer maps each to its own copy. */
export const POKE_REFUSALS = [
  'pokes_off',
  'teammate_pokes_off',
  'poke_cooldown',
  'poke_rate',
  'personal_account',
  'self'
] as const
export type PokeRefusal = (typeof POKE_REFUSALS)[number]
