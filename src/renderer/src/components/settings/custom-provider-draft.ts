import type { CustomProviderAccount } from '../../../../shared/custom-provider-types'
import { DEFAULT_CUSTOM_PROVIDER_ICON_ID } from './custom-provider-icon-options'
import { translate } from '@/i18n/i18n'

export type CustomProviderDraft = {
  displayName: string
  icon: string
  usageUrl: string
  token: string
  /** If set and resolvable in the main process's env, takes priority over `token`. */
  tokenEnvVar: string
  mappingMode: 'percent' | 'used-limit'
  percentPath: string
  usedPaths: string[]
  limitPath: string
}

export const EMPTY_CUSTOM_PROVIDER_DRAFT: CustomProviderDraft = {
  displayName: '',
  icon: DEFAULT_CUSTOM_PROVIDER_ICON_ID,
  usageUrl: '',
  token: '',
  tokenEnvVar: '',
  mappingMode: 'percent',
  percentPath: '',
  usedPaths: [''],
  limitPath: ''
}

export function getEditingDraftForAccount(account: CustomProviderAccount): CustomProviderDraft {
  return {
    displayName: account.displayName,
    icon: account.icon ?? DEFAULT_CUSTOM_PROVIDER_ICON_ID,
    usageUrl: account.usageUrl,
    // Why: never round-trip the saved token back into the form — same
    // convention as MiniMax's cookie draft. Blank means "keep the existing one".
    token: '',
    tokenEnvVar: account.tokenEnvVar ?? '',
    mappingMode: account.mappingMode,
    percentPath: account.percentPath ?? '',
    usedPaths: account.usedPaths && account.usedPaths.length > 0 ? account.usedPaths : [''],
    limitPath: account.limitPath ?? ''
  }
}

export type CustomProviderDraftValidation = { ok: true } | { ok: false; error: string }

// Why: the wire schema (client-ui-schemas.ts) enforces this too, but only for the
// paired-client RPC surface — the everyday local Settings save goes through the
// unvalidated settings:set path, so the real guardrail has to live here.
export function validateCustomProviderDraft(
  draft: CustomProviderDraft,
  existingAccounts: CustomProviderAccount[],
  editingId: string | null
): CustomProviderDraftValidation {
  const displayName = draft.displayName.trim()
  if (!displayName) {
    return {
      ok: false,
      error: translate(
        'auto.components.settings.customProviderDraft.nameRequired',
        'Name is required.'
      )
    }
  }
  const nameKey = displayName.toLowerCase()
  if (
    existingAccounts.some(
      (account) => account.id !== editingId && account.displayName.trim().toLowerCase() === nameKey
    )
  ) {
    return {
      ok: false,
      error: translate(
        'auto.components.settings.customProviderDraft.duplicateName',
        'An account named "{{value0}}" already exists.',
        { value0: displayName }
      )
    }
  }
  if (!draft.usageUrl.trim().startsWith('https://')) {
    return {
      ok: false,
      error: translate(
        'auto.components.settings.customProviderDraft.urlMustBeHttps',
        'Usage URL must start with https://.'
      )
    }
  }
  if (draft.mappingMode === 'percent') {
    if (!draft.percentPath.trim()) {
      return {
        ok: false,
        error: translate(
          'auto.components.settings.customProviderDraft.percentPathRequired',
          'Percent path is required.'
        )
      }
    }
  } else {
    const usedPaths = draft.usedPaths.map((path) => path.trim()).filter(Boolean)
    if (usedPaths.length === 0) {
      return {
        ok: false,
        error: translate(
          'auto.components.settings.customProviderDraft.usedPathRequired',
          'At least one used-value path is required.'
        )
      }
    }
    if (!draft.limitPath.trim()) {
      return {
        ok: false,
        error: translate(
          'auto.components.settings.customProviderDraft.limitPathRequired',
          'Limit path is required.'
        )
      }
    }
  }
  return { ok: true }
}

export function buildCustomProviderAccount(
  draft: CustomProviderDraft,
  existing: CustomProviderAccount | null
): Omit<CustomProviderAccount, 'id' | 'createdAt'> {
  return {
    displayName: draft.displayName.trim(),
    enabled: existing?.enabled ?? true,
    icon: draft.icon,
    usageUrl: draft.usageUrl.trim(),
    ...(draft.tokenEnvVar.trim() ? { tokenEnvVar: draft.tokenEnvVar.trim() } : {}),
    mappingMode: draft.mappingMode,
    ...(draft.mappingMode === 'percent'
      ? { percentPath: draft.percentPath.trim() }
      : {
          usedPaths: draft.usedPaths.map((path) => path.trim()).filter(Boolean),
          limitPath: draft.limitPath.trim()
        }),
    // Why: this call always represents a fresh save (test-draft calls don't
    // persist), so the edit timestamp should always advance — not the
    // previous save's stamp.
    updatedAt: Date.now()
  }
}
