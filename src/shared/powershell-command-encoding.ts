export function encodePowerShellCommand(command: string): string {
  // Why: some callers (setup sequencing, Hermes startup) run in the sandboxed
  // renderer where Node's Buffer is unavailable, so encode the UTF-16LE bytes
  // PowerShell's -EncodedCommand expects using only renderer-safe globals.
  let bytes = ''
  for (let index = 0; index < command.length; index += 1) {
    const code = command.charCodeAt(index)
    bytes += String.fromCharCode(code & 0xff, code >>> 8)
  }
  return btoa(bytes)
}
