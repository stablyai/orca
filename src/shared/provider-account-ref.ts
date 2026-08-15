export const PROVIDER_ACCOUNT_REF_MAX_ID_LENGTH = 256
export const PROVIDER_ACCOUNT_REF_MAX_PROVIDER_LENGTH = 64
export const PROVIDER_ACCOUNT_REF_MAX_WSL_DISTRO_LENGTH = 128

export type ProviderAccountRef = {
  provider: string
  accountId: string | null
  runtime: 'host' | 'wsl'
  wslDistro?: string | null
}

function isBoundedRefString(value: unknown, maxLength: number): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= maxLength &&
    !value.includes('\0') &&
    !value.includes('\r') &&
    !value.includes('\n')
  )
}

export function isProviderAccountRef(value: unknown): value is ProviderAccountRef {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const ref = value as Partial<ProviderAccountRef>
  const keys = Object.keys(value)
  if (keys.some((key) => !['provider', 'accountId', 'runtime', 'wslDistro'].includes(key))) {
    return false
  }
  if (
    !isBoundedRefString(ref.provider, PROVIDER_ACCOUNT_REF_MAX_PROVIDER_LENGTH) ||
    (ref.accountId !== null &&
      !isBoundedRefString(ref.accountId, PROVIDER_ACCOUNT_REF_MAX_ID_LENGTH)) ||
    (ref.runtime !== 'host' && ref.runtime !== 'wsl') ||
    (ref.wslDistro !== undefined &&
      ref.wslDistro !== null &&
      !isBoundedRefString(ref.wslDistro, PROVIDER_ACCOUNT_REF_MAX_WSL_DISTRO_LENGTH))
  ) {
    return false
  }
  return ref.runtime === 'wsl' || ref.wslDistro === undefined || ref.wslDistro === null
}
