/**
 * Canonical form for an SSH config alias. OpenSSH matches Host patterns
 * case-insensitively, so the picker, import reconciliation, delete tombstones
 * and the save-time duplicate check must all compare aliases through this.
 */
export function normalizeSshConfigAlias(alias: string | null | undefined): string {
  return alias ? alias.trim().toLowerCase() : ''
}
