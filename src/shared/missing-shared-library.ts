/** Missing libraries can be installed; unavailable glibc symbol versions require rebuilding. */
export function parseMissingSharedLibrary(loaderError: string): string | null {
  const elf = loaderError.match(/([\w.+-]+\.so[\w.]*): cannot open shared object file/)
  if (elf) {
    return elf[1]
  }
  const musl = loaderError.match(/Error loading shared library ([\w.+-]+\.so[\w.]*)/)
  if (musl) {
    return musl[1]
  }
  const machO = loaderError.match(/Library not loaded:\s*(\S+)/)
  return machO ? machO[1] : null
}
