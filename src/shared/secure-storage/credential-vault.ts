export const CREDENTIAL_VAULT_LIMITS = { name: 120, username: 256, website: 512, value: 4096 }

export type VaultEntryFields = {
  kind: 'login' | 'secret'
  name: string
  username: string
  website: string
}

export type VaultEntry = VaultEntryFields & { id: string }
export type VaultEntryDraft = VaultEntryFields & { id?: string; value?: string }

export const VAULT_FAILURE_REASONS = [
  'unprotected',
  'unavailable',
  'invalid',
  'missing',
  'full',
  'auth-failed',
  'forbidden',
  'unsupported'
] as const

export type VaultResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: (typeof VAULT_FAILURE_REASONS)[number] }

export type ServerVaultTarget = { environmentId: string; pairingRevision: number }
export type BotToolVaultDestination = { botId: string; name: string; url: string }
export type BotToolVaultBinding = { id: string; scheme: 'bearer' | 'api-key' }
export type BotToolVaultEdit = BotToolVaultDestination & {
  version: string
  binding?: BotToolVaultBinding
}
export type BotToolVaultCreate = BotToolVaultDestination & {
  create: true
  binding: BotToolVaultBinding
}
export type BotToolVaultChange = BotToolVaultEdit | BotToolVaultCreate

export type CredentialVaultApi = {
  list: (target?: ServerVaultTarget) => Promise<VaultResult<VaultEntry[]>>
  save: (draft: VaultEntryDraft, target?: ServerVaultTarget) => Promise<VaultResult<VaultEntry[]>>
  remove: (id: string, target?: ServerVaultTarget) => Promise<VaultResult<VaultEntry[]>>
  copy: (id: string, target?: ServerVaultTarget) => Promise<VaultResult<true>>
  changeBotTool: (
    change: BotToolVaultChange,
    target: ServerVaultTarget
  ) => Promise<VaultResult<true>>
}
