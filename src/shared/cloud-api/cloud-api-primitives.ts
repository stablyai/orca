// Shared zod building blocks for the Orca Cloud /v1 wire types.
import { z } from 'zod'

export const Id = z.string().min(1).max(128)
// Server-provided links are opened in the browser: only ever https.
export const HttpsUrl = z.url({ protocol: /^https$/ }).max(2048)
export const Millis = z.number().int().nonnegative()
/** A teammate's display name when the control plane knows it (W4 member_names); null otherwise. */
// A malformed name degrades to null rather than failing the whole response.
export const PersonName = z.string().trim().max(200).nullable().optional().catch(null)
