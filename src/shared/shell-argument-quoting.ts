// Quoting spellings are byte contracts consumed by parsers/comparisons; keep variants separate.
// PowerShell lives in powershell-native-argument.ts; CommandLineToArgvW in @orca/process-host.

/** POSIX sh single-quoting: each `'` closes the quote, is escaped, and reopens it (`'\''`). */
export function quotePosixShell(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

/** As `quotePosixShell`, but a non-empty word of only `A-Za-z0-9_./@:-` stays bare. */
export function quotePosixShellUnlessPlain(value: string): string {
  return /^[a-zA-Z0-9_./@:-]+$/.test(value) ? value : quotePosixShell(value)
}

/** As `quotePosixShellUnlessPlain`, except `@` also forces quoting. */
export function quotePosixShellUnlessPlainNoAt(value: string): string {
  return /^[A-Za-z0-9_./:-]+$/.test(value) ? value : quotePosixShell(value)
}

/** Keep this POSIX apostrophe spelling: installed CLI wrapper readers in legacy-appimage-cli-wrapper.ts/wsl-cli-scripts.ts require it. */
export function quotePosixShellDoubleQuotedApostrophe(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

/** cmd.exe double-quoting with `"` doubled. Leaves `%`, `^` and `!` as they are. */
export function quoteCmdDoubleQuoted(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}
