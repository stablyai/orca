import { z } from 'zod'
import { isAgentSessionOptions } from '../agent-session-record'
import { measureUtf8ByteLength } from '../utf8-byte-limits'

export const AgentSessionOptions = z.record(z.string(), z.string()).refine(isAgentSessionOptions)

export const MAX_PROMPT_BYTES = 256 * 1024
export const MAX_BLOCKS = 64
export const MAX_OPTION_LABEL = 512

export const SendImageRefBlock = z
  .object({
    type: z.literal('image-ref'),
    path: z.string().min(1).max(4096).optional(),
    url: z.string().min(1).max(4096).optional(),
    alt: z.string().max(MAX_OPTION_LABEL).optional()
  })
  .strict()
  .refine((value) => Boolean(value.path) !== Boolean(value.url), 'Provide exactly one of path/url')

/** Clients may only author user turns. Accepting an assistant or tool role here
 *  would let one client write words into the agent's mouth in another's
 *  timeline, and the provider — not the client — owns those. */
export const SendBlock = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }).strict(),
  SendImageRefBlock
])

export const MAX_SKILL_REFS = 16

/** A skill the user picked from the menu, by the file its agent selects it by. */
export const SendSkillRef = z
  .object({ name: z.string().min(1).max(MAX_OPTION_LABEL), path: z.string().min(1).max(4096) })
  .strict()

export const SendBodyStructure = z
  .object({
    kind: z.literal('message'),
    role: z.literal('user'),
    blocks: z.array(SendBlock).min(1).max(MAX_BLOCKS),
    skills: z.array(SendSkillRef).min(1).max(MAX_SKILL_REFS).optional()
  })
  .strict()

/** UTF-8 size of a message's blocks as sent, measured where `Buffer` is absent exactly as `SendBody`
 *  measures it on the host, so a client refuses before Send what the host would. */
export function structuredAgentSessionBlocksByteLength(blocks: readonly unknown[]): number {
  return measureUtf8ByteLength(JSON.stringify(blocks)).byteLength
}

export function structuredAgentSessionBlocksTooLarge(blocks: readonly unknown[]): boolean {
  return measureUtf8ByteLength(JSON.stringify(blocks), { stopAfterBytes: MAX_PROMPT_BYTES })
    .exceededLimit
}

export const SendBody = SendBodyStructure.refine(
  (value) => Buffer.byteLength(JSON.stringify(value.blocks), 'utf8') <= MAX_PROMPT_BYTES,
  'Message is too large'
)
