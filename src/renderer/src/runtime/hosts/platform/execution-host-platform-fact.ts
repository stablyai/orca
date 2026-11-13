import type { ParsedExecutionHost } from '../../../../../shared/execution-host'

/** Withhold unreported execution OS; quoting with client/endpoint guesses would target the wrong shell and must stop launch. */
export type ExecutionHostPlatformFact =
  | {
      kind: 'known'
      platform: NodeJS.Platform
      hostKind: ParsedExecutionHost['kind']
      /** A paired server's own Windows terminal shell, when it reported one. */
      terminalWindowsShell?: string | null
    }
  | {
      kind: 'withheld'
      reason: string
      recovery:
        | 'connectSsh'
        | 'sshUnavailable'
        | 'reconnectServer'
        | 'updateServer'
        | 'refreshProjects'
      pending?: boolean
    }
