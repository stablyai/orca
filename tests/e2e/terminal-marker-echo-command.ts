// Split markers so only command output rejoins them; shell command echo must not satisfy execution assertions.
export function splitMarkerEchoCommand(prefix: string, suffix: string): string {
  return process.platform === 'win32'
    ? `Write-Output ('${prefix}' + '${suffix}')`
    : `echo "${prefix}""${suffix}"`
}
