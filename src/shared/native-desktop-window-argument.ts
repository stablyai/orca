const PREFIX = '--orca-native-window='

export function formatNativeDesktopWindowArgument(id: string): string {
  return `${PREFIX}${encodeURIComponent(id)}`
}

export function readNativeDesktopWindowArgument(argv: readonly string[]): string | null {
  const value = argv.find((argument) => argument.startsWith(PREFIX))?.slice(PREFIX.length)
  if (!value) {
    return null
  }
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}
