import { z } from 'zod'
import { BOT_TOOL_NAME_PATTERN, BotToolUrl } from '../../bot-tools'
import { CREDENTIAL_VAULT_LIMITS as limits } from '../../secure-storage/credential-vault'

export const CREDENTIAL_VAULT_METHOD = 'credentialVault.operate'
export const vaultIdSchema = z.uuid()
const fields = z.object({
  kind: z.enum(['login', 'secret']),
  name: z.string().trim().min(1).max(limits.name),
  username: z.string().trim().max(limits.username),
  website: z.string().trim().max(limits.website)
})
export const vaultEntrySchema = fields.extend({ id: vaultIdSchema })
export const vaultValueSchema = z.string().min(1).max(limits.value)
export const vaultDraftSchema = fields.extend({
  id: vaultIdSchema.optional(),
  value: vaultValueSchema.optional()
})

const botToolVaultDestination = z.object({
  botId: z.string().min(1).max(128),
  name: z.string().regex(BOT_TOOL_NAME_PATTERN),
  url: BotToolUrl
})
const botToolVaultBinding = z.object({ id: vaultIdSchema, scheme: z.enum(['bearer', 'api-key']) })
export const botToolVaultChangeSchema = z.union([
  botToolVaultDestination.extend({
    create: z.literal(true),
    version: z.never().optional(),
    binding: botToolVaultBinding
  }),
  botToolVaultDestination.extend({
    create: z.never().optional(),
    version: z.string().regex(/^[a-f0-9]{64}$/),
    binding: botToolVaultBinding.optional()
  })
])

export const CredentialVaultOperation = z.discriminatedUnion('op', [
  z.object({ op: z.literal('list') }),
  z.object({ op: z.literal('save'), draft: vaultDraftSchema }),
  z.object({ op: z.literal('remove'), id: vaultIdSchema }),
  z.object({ op: z.literal('read'), id: vaultIdSchema }),
  z.object({ op: z.literal('bot-tool'), change: botToolVaultChangeSchema })
])

export type CredentialVaultOperation = z.infer<typeof CredentialVaultOperation>
