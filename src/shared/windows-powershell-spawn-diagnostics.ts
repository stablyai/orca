export type WindowsPowerShellStartupDeliveryKind = 'shell-args' | 'stdin' | 'none'

export type WindowsPowerShellSpawnDiagnostic = {
  shellPath: string
  cwd: string
  startupDelivery: WindowsPowerShellStartupDeliveryKind
  safeModeNoProfile: boolean
  sessionId?: string
  fallbackFromShellPath?: string
}

function formatOptionalField(name: string, value: string | undefined): string[] {
  return value ? [`${name}=${value}`] : []
}

export function formatWindowsPowerShellSpawnDiagnostic(
  diagnostic: WindowsPowerShellSpawnDiagnostic
): string {
  return [
    'windows-powershell-spawn',
    ...formatOptionalField('sessionId', diagnostic.sessionId),
    ...formatOptionalField('fallbackFrom', diagnostic.fallbackFromShellPath),
    `shell=${diagnostic.shellPath}`,
    `cwd=${diagnostic.cwd}`,
    `startupDelivery=${diagnostic.startupDelivery}`,
    `safeModeNoProfile=${diagnostic.safeModeNoProfile ? 'true' : 'false'}`
  ].join(' ')
}

export function formatWindowsPowerShellCrashCorrelationHint(args: {
  shellPath: string
  sessionId?: string
}): string {
  return [
    'windows-powershell-crash-correlation',
    ...formatOptionalField('sessionId', args.sessionId),
    `shell=${args.shellPath}`,
    'eventLogProvider=.NET Runtime',
    'eventLogProcess=pwsh.exe',
    'eventLogException=No process is on the other end of the pipe'
  ].join(' ')
}
