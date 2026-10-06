import { randomUUID } from 'node:crypto'
import { readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getSpawnArgsForWindows, wrapWindowsStartWait } from './windows-batch-spawn'
import { getWindowsPowerShellHost } from './windows-powershell-host'

export type WindowsHostInteractiveLoginSpawn = {
  command: string
  args: string[]
  stdio: 'ignore'
  windowsHide: boolean
  cleanup: () => void
  getTerminationPid: () => number | null
  waitForTerminationPid: () => Promise<number | null>
  /** PID proof is necessary because start /wait does not relay the payload exit code. */
  hasRelayedPid: () => boolean
}

const PID_RELAY_WAIT_TIMEOUT_MS = 2_000
const PID_RELAY_POLL_INTERVAL_MS = 25

function encodeUtf8(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64')
}

function buildPidRelayScript(command: string, args: string[], pidFilePath: string): string {
  const decode =
    'function Read-OrcaValue([string]$Value) { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Value)) }'
  const encodedArgs = args.map((arg) => `(Read-OrcaValue '${encodeUtf8(arg)}')`).join(',')
  return [
    decode,
    `$Command = Read-OrcaValue '${encodeUtf8(command)}'`,
    `$Arguments = @(${encodedArgs})`,
    `[IO.File]::WriteAllText((Read-OrcaValue '${encodeUtf8(pidFilePath)}'), [string]$PID)`,
    '& $Command @Arguments',
    'if ($null -eq $LASTEXITCODE) { exit 0 }',
    'exit $LASTEXITCODE'
  ].join('; ')
}

function readPidFile(pidFilePath: string): number | null {
  try {
    const pid = Number.parseInt(readFileSync(pidFilePath, 'utf8').trim(), 10)
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

function waitForPidFile(pidFilePath: string): Promise<number | null> {
  const current = readPidFile(pidFilePath)
  if (current !== null) {
    return Promise.resolve(current)
  }
  const deadline = Date.now() + PID_RELAY_WAIT_TIMEOUT_MS
  return new Promise((resolve) => {
    const poll = (): void => {
      const pid = readPidFile(pidFilePath)
      if (pid !== null || Date.now() >= deadline) {
        resolve(pid)
        return
      }
      setTimeout(poll, PID_RELAY_POLL_INTERVAL_MS)
    }
    setTimeout(poll, PID_RELAY_POLL_INTERVAL_MS)
  })
}

export function buildWindowsHostInteractiveLoginSpawn(
  command: string,
  args: string[],
  powerShellHost: string = getWindowsPowerShellHost()
): WindowsHostInteractiveLoginSpawn {
  const { spawnCmd, spawnArgs } = getSpawnArgsForWindows(command, args)
  const pidFilePath = join(tmpdir(), `orca-interactive-login-${randomUUID()}.pid`)
  const script = buildPidRelayScript(spawnCmd, spawnArgs, pidFilePath)
  // Encoded payloads need no policy bypass; encoding protects the cmd.exe reparsing boundary.
  const wrapped = wrapWindowsStartWait(powerShellHost, [
    '-NoLogo',
    '-NoProfile',
    '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64')
  ])
  // Preserve startup proof after cleanup removes the relay file.
  let relayedPid: number | null = null
  const capturePid = (): number | null => (relayedPid ??= readPidFile(pidFilePath))
  return {
    command: wrapped.spawnCmd,
    args: wrapped.spawnArgs,
    stdio: 'ignore',
    windowsHide: true,
    cleanup: () => {
      capturePid()
      rmSync(pidFilePath, { force: true })
    },
    getTerminationPid: () => capturePid(),
    waitForTerminationPid: async () => {
      // Cleanup may already have deleted the file whose PID we captured.
      if (relayedPid !== null) {
        return relayedPid
      }
      relayedPid = await waitForPidFile(pidFilePath)
      return relayedPid
    },
    hasRelayedPid: () => capturePid() !== null
  }
}
