import type { MachineProviderKey } from '../../../../shared/machine-inventory'
import type {
  MachineLifetime,
  MachineProviderCapabilities
} from '../../../../shared/machine-provider-protocol'

/** What "New machine on X" will create, edited in the composer's Advanced section. */
export type MachineCreateDraft = {
  providerKey: MachineProviderKey
  lifetime: MachineLifetime
  /** Only for Temporary; capped at the provider's maximum. */
  ttlSeconds: number | null
  image: string | null
  /** Empty means "name it after the worktree" at submit. */
  name: string
}

const HOUR = 60 * 60
const TTL_CHOICES_SECONDS = [HOUR, 2 * HOUR, 4 * HOUR, 8 * HOUR, 24 * HOUR, 72 * HOUR]

/** Durations offered for Temporary, never past the provider's cap; its default is always listed. */
export function getMachineTtlChoices(
  capabilities: MachineProviderCapabilities | undefined
): number[] {
  const max = capabilities?.maxTtlSeconds ?? Number.POSITIVE_INFINITY
  const choices = TTL_CHOICES_SECONDS.filter((seconds) => seconds <= max)
  const fallback = capabilities?.defaultTtlSeconds
  if (fallback && fallback <= max && !choices.includes(fallback)) {
    choices.push(fallback)
  }
  if (choices.length === 0 && Number.isFinite(max)) {
    choices.push(max)
  }
  return choices.sort((a, b) => a - b)
}

/** The provider's default duration when it is offered, else the shortest choice. */
export function getDefaultMachineTtl(
  capabilities: MachineProviderCapabilities | undefined
): number | null {
  const choices = getMachineTtlChoices(capabilities)
  const preferred = capabilities?.defaultTtlSeconds
  return preferred && choices.includes(preferred) ? preferred : (choices[0] ?? null)
}

/** Temporary when the provider supports it, its default image and TTL, named after the worktree. */
export function createMachineDraft(
  providerKey: MachineProviderKey,
  capabilities: MachineProviderCapabilities | undefined
): MachineCreateDraft {
  const lifetimes = capabilities?.lifetimes ?? ['persistent']
  const lifetime: MachineLifetime = lifetimes.includes('temporary') ? 'temporary' : 'persistent'
  return {
    providerKey,
    lifetime,
    ttlSeconds: lifetime === 'temporary' ? getDefaultMachineTtl(capabilities) : null,
    image: capabilities?.defaultImage ?? capabilities?.images?.[0]?.id ?? null,
    name: ''
  }
}

/** Local epoch ms a Temporary machine created now would be deleted. */
export function getDraftExpiry(draft: MachineCreateDraft, now: number): number | null {
  return draft.lifetime === 'temporary' && draft.ttlSeconds ? now + draft.ttlSeconds * 1000 : null
}

/** Providers accept `[A-Za-z0-9._-]{1,63}` starting and ending with a letter or digit. */
export function toMachineName(raw: string): string {
  return (
    raw
      .normalize('NFKD')
      // Why: accents fold to their base letter, so "über" names a machine "uber", not "ber".
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .slice(0, 63)
      .replace(/^[-._]+|[-._]+$/g, '')
  )
}

/** The name a create will use: the typed name, else the worktree's, else a unique fallback. */
export function resolveMachineName(
  draft: MachineCreateDraft,
  worktreeName: string,
  fallbackSuffix: () => string
): string {
  return (
    toMachineName(draft.name.trim() || worktreeName) || `machine-${fallbackSuffix().slice(0, 6)}`
  )
}
