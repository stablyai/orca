import { quoteWindowsArgument } from '@orca/process-host/windows-command-line'

/** Every Zotz task lives under this Task Scheduler folder so cleanup never touches foreign tasks. */
export const ZOTZ_WINDOWS_TASK_FOLDER = '\\Zotz\\'

export type ZotzWindowsScheduledTaskInput = {
  /** Folder-qualified task path, e.g. `\Zotz\Server`. */
  taskPath: string
  /** `DOMAIN\user` the task runs as; logon trigger and principal both pin to it. */
  userId: string
  command: string
  args: readonly string[]
  workingDirectory?: string
  description: string
  /** S4U runs without a window or desktop session: right for headless `serve`, wrong for the app. */
  logonType?: 'InteractiveToken' | 'S4U'
}

// Element text only: quotes stay literal so the stored command line reads as typed.
function xmlText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function zotzWindowsTaskPath(name: string): string {
  return `${ZOTZ_WINDOWS_TASK_FOLDER}${name}`
}

/** Joins argv the way CommandLineToArgvW splits it back. */
export function windowsTaskArguments(args: readonly string[]): string {
  return args.map(quoteWindowsArgument).join(' ')
}

/**
 * Task Scheduler XML for a desktop-session supervisor: InteractiveToken keeps the process in the
 * user's session (a Windows service runs in session 0, where computer use and the browser cannot
 * reach a desktop). RestartOnFailure is not a reliable crash watchdog, so the logon trigger also
 * repeats every minute with IgnoreNew: a running instance is left alone and a dead one comes back.
 */
export function renderZotzWindowsScheduledTaskXml(input: ZotzWindowsScheduledTaskInput): string {
  const user = xmlText(input.userId)
  const workingDirectory = input.workingDirectory
    ? `\n      <WorkingDirectory>${xmlText(input.workingDirectory)}</WorkingDirectory>`
    : ''
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>${xmlText(input.description)}</Description>
    <URI>${xmlText(input.taskPath)}</URI>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${user}</UserId>
      <Repetition>
        <Interval>PT1M</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${user}</UserId>
      <LogonType>${input.logonType ?? 'InteractiveToken'}</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>4</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlText(input.command)}</Command>
      <Arguments>${xmlText(windowsTaskArguments(input.args))}</Arguments>${workingDirectory}
    </Exec>
  </Actions>
</Task>
`
}

/** schtasks /XML rejects UTF-8 files that declare UTF-16, so write a BOM-prefixed UTF-16LE buffer. */
export function encodeWindowsTaskXml(content: string): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(content, 'utf16le')])
}

/** The account Task Scheduler needs, read in the unelevated session (an admin prompt may switch users). */
export function resolveWindowsTaskUserId(env: NodeJS.ProcessEnv, username: string): string {
  const domain = env.USERDOMAIN?.trim()
  return domain ? `${domain}\\${username}` : username
}
