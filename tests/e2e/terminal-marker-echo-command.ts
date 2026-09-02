// Why: the shell echoes the command line back into the buffer, so a marker written as one literal
// would satisfy an output assertion even if the command never ran. Splitting it into two fragments
// that only rejoin in the command's output makes the assertion proof of execution.
export function splitMarkerEchoCommand(prefix: string, suffix: string): string {
  return process.platform === 'win32'
    ? `Write-Output ('${prefix}' + '${suffix}')`
    : `echo "${prefix}""${suffix}"`
}
