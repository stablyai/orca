import * as z from 'zod'

export const OrcaAccountSignInStartParams = z.object({
  switchAccount: z.boolean().optional(),
  /** The person approves in a browser and the host finishes on its own; no code is relayed. */
  approveInBrowser: z.boolean().optional()
})

export const OrcaAccountSignInFlowParams = z.object({ flowId: z.string().min(1).max(64) })

export const OrcaAccountSignInWaitParams = OrcaAccountSignInFlowParams.extend({
  afterRevision: z.number().int().nonnegative().default(0)
})

export const OrcaAccountSignInCompleteParams = OrcaAccountSignInFlowParams.extend({
  code: z
    .string()
    .trim()
    .min(1, 'Paste the code from the sign-in page.')
    .max(4_096)
    .regex(/^[^\s\p{Cc}]+$/u, 'That code has spaces or line breaks in it. Copy it again.'),
  state: z.string().min(1).max(512),
  redirectUri: z.string().url().max(2_048)
})

export const OrcaAccountSelectOrgParams = z.object({ orgId: z.string().trim().min(1).max(256) })

export const OrcaAccountUnsubscribeParams = z.object({ subscriptionId: z.string().min(1) })
