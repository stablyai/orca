// One home for shell-argument quoting. Each spelling below is a separate contract: callers embed,
// compare or parse back these exact bytes, so variants stay separate functions, never flags.
// PowerShell quoting lives in powershell-native-argument.ts; CommandLineToArgvW in @orca/process-host.

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

/**
 * POSIX sh single-quoting that spells each `'` as `'"'"'`. Installed CLI wrappers are read back
 * in this spelling (legacy-appimage-cli-wrapper.ts, wsl-cli-scripts.ts), so it must not change.
 */
export function quotePosixShellDoubleQuotedApostrophe(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

/** cmd.exe double-quoting with `"` doubled. Leaves `%`, `^` and `!` as they are. */
export function quoteCmdDoubleQuoted(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}
