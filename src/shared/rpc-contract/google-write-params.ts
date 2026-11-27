import * as z from 'zod'
import { lazyZodSchema } from '../schema/lazy-zod-schema'
import { GoogleCallParams, GoogleRef } from './google-call-params'

const People = lazyZodSchema(() => z.array(z.string().trim().min(1).max(512)).max(100).default([]))
const Text = lazyZodSchema(() => z.string().max(200_000))
const Short = lazyZodSchema(() => z.string().trim().min(1).max(1_024))
// Base64 of one file; the draft's total is checked against Gmail's cap on the host.
const Attachment = lazyZodSchema(() =>
  z.object({ name: z.string().trim().min(1).max(255), data: z.string() })
)

export const GmailDraftParams = lazyZodSchema(() =>
  z.object({
    ...GoogleCallParams,
    to: People,
    cc: People,
    bcc: People,
    subject: z.string().max(998).optional(),
    body: Text.optional(),
    replyTo: GoogleRef.optional(),
    replyAll: z.boolean().optional(),
    forward: GoogleRef.optional(),
    draft: GoogleRef.optional(),
    attachments: z.array(Attachment).max(20).default([])
  })
)

export const GmailSendParams = lazyZodSchema(() =>
  z.object({ ...GoogleCallParams, ref: GoogleRef })
)

export const GmailModifyParams = lazyZodSchema(() =>
  z.object({
    ...GoogleCallParams,
    refs: z.array(GoogleRef).min(1).max(100),
    add: z.array(Short).max(20).default([]),
    remove: z.array(Short).max(20).default([])
  })
)

const createEventFields = () => ({
  calendar: Short.optional(),
  title: z.string().max(1_024).optional(),
  start: Short.optional(),
  end: Short.optional(),
  duration: Short.optional(),
  tz: Short.optional(),
  where: z.string().max(1_024).optional(),
  body: Text.optional(),
  with: People,
  meet: z.boolean().optional(),
  notify: z.boolean().default(true)
})

export const CalendarCreateParams = lazyZodSchema(() =>
  z.object({
    ...GoogleCallParams,
    ...createEventFields(),
    allDay: z.boolean().optional(),
    repeat: Short.optional()
  })
)

export const CalendarUpdateParams = lazyZodSchema(() =>
  z.object({
    ...GoogleCallParams,
    ...createEventFields(),
    ref: GoogleRef,
    series: z.boolean().optional(),
    without: People
  })
)

export const CalendarDeleteParams = lazyZodSchema(() =>
  z.object({
    ...GoogleCallParams,
    ref: GoogleRef,
    calendar: Short.optional(),
    series: z.boolean().optional(),
    notify: z.boolean().default(true)
  })
)

export const CalendarRespondParams = lazyZodSchema(() =>
  z.object({
    ...GoogleCallParams,
    ref: GoogleRef,
    answer: z.enum(['accept', 'decline', 'maybe'], {
      message: 'Answer accept, decline or maybe.'
    }),
    calendar: Short.optional(),
    series: z.boolean().optional()
  })
)

export const CalendarSuggestTimeParams = lazyZodSchema(() =>
  z.object({
    ...GoogleCallParams,
    with: z.array(z.string().trim().min(1).max(512)).min(1, 'Say who with --with.').max(49),
    duration: Short,
    hours: Short.optional(),
    from: Short.optional(),
    to: Short.optional()
  })
)
