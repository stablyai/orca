export type WindowsPowerShellStartupDeliveryKind = 'shell-args' | 'stdin' | 'none'

export type WindowsPowerShellSpawnDiagnostic = {
  shellPath: string
  cwd?: string
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
    ...formatOptionalField('cwd', diagnostic.cwd),
    `startupDelivery=${diagnostic.startupDelivery}`,
    `safeModeNoProfile=${diagnostic.safeModeNoProfile ? 'true' : 'false'}`
  ].join(' ')
}

export function getWindowsPowerShellFallbackStartupDelivery(args: {
  shellReadyMarker?: string
  startupCommandDeliveredInShellArgs?: boolean
}): WindowsPowerShellStartupDeliveryKind {
  // Why: shell-args delivery wins over the stdin marker because a cmd.exe
  // fallback embeds the startup command in argv and cannot use the PowerShell
  // ready-marker mechanism; flipping this order would double-deliver or drop it.
  if (args.startupCommandDeliveredInShellArgs === true) {
    return 'shell-args'
  }
  return args.shellReadyMarker === '1' ? 'stdin' : 'none'
}

export function formatWindowsPowerShellCrashCorrelationHint(args: {
  shellPath: string
  sessionId?: string
}): string {
  // Why: these literals match the exact pwsh ConsoleHost FailFast Event Log
  // signature this crash targets; they must stay verbatim so operators can
  // correlate a spawn failure against the Windows Application event log entry.
  return [
    'windows-powershell-crash-correlation',
    ...formatOptionalField('sessionId', args.sessionId),
    `shell=${args.shellPath}`,
    'eventLogProvider=.NET Runtime',
    'eventLogProcess=pwsh.exe',
    'eventLogException=No process is on the other end of the pipe'
  ].join(' ')
}
