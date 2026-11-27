import * as z from 'zod'
import { lazyZodSchema } from '../schema/lazy-zod-schema'
import { GoogleCallParams, GoogleRef } from './google-call-params'
const PageToken = lazyZodSchema(() => z.string().min(1).max(2_048).optional())

export const GmailSearchParams = lazyZodSchema(() =>
  z.object({
    ...GoogleCallParams,
    query: z.string().trim().min(1, 'Give a Gmail search, e.g. from:sam newer_than:7d').max(2_048),
    pageToken: PageToken,
    limit: z.number().int().min(1).max(50).optional()
  })
)

export const GmailReadParams = lazyZodSchema(() =>
  z.object({
    ...GoogleCallParams,
    ref: GoogleRef,
    offset: z.number().int().nonnegative().optional()
  })
)

export const GmailAttachmentParams = lazyZodSchema(() =>
  z.object({ ...GoogleCallParams, ref: GoogleRef })
)

export const CalendarListParams = lazyZodSchema(() =>
  z.object({
    ...GoogleCallParams,
    calendar: z.string().trim().min(1).max(512).optional(),
    from: z.string().trim().min(1).max(64).optional(),
    to: z.string().trim().min(1).max(64).optional(),
    pageToken: PageToken
  })
)

export const CalendarCalendarsParams = lazyZodSchema(() => z.object(GoogleCallParams))

export const CalendarGetParams = lazyZodSchema(() =>
  z.object({
    ...GoogleCallParams,
    ref: GoogleRef,
    calendar: z.string().trim().min(1).max(512).optional()
  })
)

export const ContactsFindParams = lazyZodSchema(() =>
  z.object({
    ...GoogleCallParams,
    query: z.string().trim().min(1, 'Name someone to look up.').max(200)
  })
)
