/** OpenSSH Host matching is case-insensitive; share normalization across picker/import/tombstone/duplicate checks. */
export function normalizeSshConfigAlias(alias: string | null | undefined): string {
  return alias ? alias.trim().toLowerCase() : ''
}
