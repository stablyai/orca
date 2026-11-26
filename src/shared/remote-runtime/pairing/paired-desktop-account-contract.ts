import { z } from 'zod'

// A paired desktop says which Orca account it is signed in to (null: none), on each ready control
// socket and when it switches, with its computer's name. The host keeps it on the device's row and
// that socket; a plain claim, not proof.
export const DECLARE_ORCA_ACCOUNT_METHOD = 'host.declareAccount'

export const DeclareOrcaAccountParamsSchema = z
  .object({
    account: z
      .object({
        id: z.string().min(1).max(128),
        name: z.string().max(80),
        computer: z.string().max(64).optional()
      })
      .strict()
      .nullable(),
    // A random id per desktop installation: a phone it relays or pairs is named by its claim.
    clientInstanceId: z.string().min(1).max(128).optional()
  })
  .strict()

export type DeclareOrcaAccountParams = z.infer<typeof DeclareOrcaAccountParamsSchema>
