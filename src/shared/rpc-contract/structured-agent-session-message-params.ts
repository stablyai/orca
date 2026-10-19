import { z } from 'zod'

export const MAX_PROMPT_BYTES = 256 * 1024
export const MAX_BLOCKS = 64
export const MAX_OPTION_LABEL = 512

/** Clients may only author user turns. Accepting an assistant or tool role here
 *  would let one client write words into the agent's mouth in another's
 *  timeline, and the provider — not the client — owns those. */
export const SendBlock = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }).strict(),
  z
    .object({
      type: z.literal('image-ref'),
      path: z.string().min(1).max(4096).optional(),
      url: z.string().min(1).max(4096).optional(),
      alt: z.string().max(MAX_OPTION_LABEL).optional()
    })
    .strict()
    .refine(
      (value) => Boolean(value.path) !== Boolean(value.url),
      'Provide exactly one of path/url'
    )
])

export const SendBodyStructure = z
  .object({
    kind: z.literal('message'),
    role: z.literal('user'),
    blocks: z.array(SendBlock).min(1).max(MAX_BLOCKS)
  })
  .strict()

export const SendBody = SendBodyStructure.refine(
  (value) => Buffer.byteLength(JSON.stringify(value.blocks), 'utf8') <= MAX_PROMPT_BYTES,
  'Message is too large'
)
