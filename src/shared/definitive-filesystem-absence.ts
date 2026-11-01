/** Only recognized absence errnos justify deleting mirrors, replacing config or clearing credentials. existsSync/catch defaults also hide permission, busy and I/O failures; unknown errors never prove absence. */
export function isDefinitiveAbsence(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}
