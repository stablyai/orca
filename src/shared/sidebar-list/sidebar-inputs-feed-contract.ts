import { z } from 'zod'
import { openEnum } from '../zod-salvage'

/** The reply's shape; an added optional field keeps it. */
export const SIDEBAR_INPUTS_SCHEMA_VERSION = 1
/**
 * What the inputs mean: bumps whenever the same inputs would build a different list.
 * 2: desktop facts carry the focused host, host labels and pinned placement (#30462).
 * 3: activity and review are keyed by row identity (host + id), not by bare id.
 */
export const SIDEBAR_INPUTS_SEMANTICS_VERSION = 3

/** A page's encoded ceiling. A phone's bridge frame (640 KiB) holds it with the RPC envelope. */
export const SIDEBAR_INPUTS_PAGE_MAX_BYTES = 256 * 1024
export const SIDEBAR_INPUTS_PAGE_MIN_BYTES = 16 * 1024

/** No pageToken reads a same-generation cursor delta, or snapshot if unavailable; tokens continue their batch. */
export const SidebarInputsReadParams = z.object({
  generation: z.string().optional(),
  cursor: z.number().int().nonnegative().optional(),
  pageToken: z.string().optional(),
  maxBytes: z.number().int().positive()
})

export type SidebarInputsReadParams = z.infer<typeof SidebarInputsReadParams>

/** One domain's entities as the batch changes them. */
const SidebarInputsDomainChangeSchema = z.object({
  upserts: z.record(z.string(), z.unknown()),
  removals: z.array(z.string()),
  /** Pieces of entities too large for one page, as JSON text joined across the batch's pages. */
  parts: z.record(z.string(), z.string())
})

export const SidebarInputsReadResultSchema = z.object({
  /** A new id each time the runtime starts; ids have no order. */
  generation: z.string(),
  /** The revision this batch brings the reader to; a reset names the current one. */
  revision: z.number().int(),
  schemaVersion: z.number().int(),
  semanticsVersion: z.number().int(),
  // A kind this build has not heard of reads as a reset: re-read from what is installed.
  kind: openEnum(['snapshot', 'delta', 'reset'], 'reset'),
  /** A delta applies only on exactly this revision; null otherwise. */
  from: z.number().int().nullable(),
  domains: z.record(z.string(), SidebarInputsDomainChangeSchema),
  /** The batch's next page; null on its last. A batch installs only once it is whole. */
  next: z.string().nullable()
})

export type SidebarInputsDomainChange = z.infer<typeof SidebarInputsDomainChangeSchema>
export type SidebarInputsReadResult = z.infer<typeof SidebarInputsReadResultSchema>

/** Carries no data: a reader re-reads through sidebarInputs.read. */
export type SidebarInputsChangedEvent = {
  type: 'sidebarInputsChanged'
  generation: string
  revision: number
}
