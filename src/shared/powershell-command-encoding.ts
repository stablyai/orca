export function encodePowerShellCommand(command: string): string {
  // Sandboxed renderers lack Buffer; use browser-safe globals for PowerShell’s required UTF-16LE encoding.
  let bytes = ''
  for (let index = 0; index < command.length; index += 1) {
    const code = command.charCodeAt(index)
    bytes += String.fromCharCode(code & 0xff, code >>> 8)
  }
  return btoa(bytes)
}
