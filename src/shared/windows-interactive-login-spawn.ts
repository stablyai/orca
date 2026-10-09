import { randomUUID } from 'node:crypto'
import { readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { getSpawnArgsForWindows, wrapWindowsStartWait } from './windows-batch-spawn'

export type WindowsHostInteractiveLoginSpawn = {
  command: string
  args: string[]
  stdio: 'ignore'
  windowsHide: boolean
  cleanup: () => void
  /** null means the CLI never reported a valid completion. */
  getExitCode: () => number | null
  getTerminationPid: () => number | null
  waitForTerminationPid: () => Promise<number | null>
}

const PID_RELAY_WAIT_TIMEOUT_MS = 2_000
const PID_RELAY_POLL_INTERVAL_MS = 25

function encodeUtf8(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64')
}

function buildPidRelayScript(
  command: string,
  args: string[],
  pidFilePath: string,
  exitFilePath: string
): string {
  const decode =
    'function Read-OrcaValue([string]$Value) { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Value)) }'
  const encodedArgs = args.map((arg) => `(Read-OrcaValue '${encodeUtf8(arg)}')`).join(',')
  return [
    decode,
    `$Command = Read-OrcaValue '${encodeUtf8(command)}'`,
    `$Arguments = @(${encodedArgs})`,
    `[IO.File]::WriteAllText((Read-OrcaValue '${encodeUtf8(pidFilePath)}'), [string]$PID)`,
    // A failed launch can leave LASTEXITCODE unset; it must not become success.
    '$ExitCode = 1',
    '$LASTEXITCODE = $null',
    'try { & $Command @Arguments; if ($null -ne $LASTEXITCODE) { $ExitCode = $LASTEXITCODE } } catch { if ($null -ne $LASTEXITCODE) { $ExitCode = $LASTEXITCODE }; [Console]::Error.WriteLine($_) }',
    `[IO.File]::WriteAllText((Read-OrcaValue '${encodeUtf8(exitFilePath)}'), [string]$ExitCode)`,
    'exit $ExitCode'
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

function readExitCodeFile(exitFilePath: string): number | null {
  try {
    const text = readFileSync(exitFilePath, 'utf8').trim()
    if (!/^-?(?:0|[1-9]\d*)$/.test(text)) {
      return null
    }
    const code = Number(text)
    return Number.isInteger(code) && code >= -2_147_483_648 && code <= 4_294_967_295 ? code : null
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
  args: string[]
): WindowsHostInteractiveLoginSpawn {
  const { spawnCmd, spawnArgs } = getSpawnArgsForWindows(command, args)
  const pidFilePath = join(tmpdir(), `orca-interactive-login-${randomUUID()}.pid`)
  const exitFilePath = `${pidFilePath}.exit`
  const powershell = win32.join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  )
  const script = buildPidRelayScript(spawnCmd, spawnArgs, pidFilePath, exitFilePath)
  // Why: `-EncodedCommand` is not execution-policy gated (only `-File` is), so `-ExecutionPolicy
  // Bypass` was a no-op — and it is one of the most heavily EDR-flagged PowerShell tokens. The
  // base64 stays: `wrapWindowsStartWait` sends this through `cmd.exe /c start`, whose
  // `assertWindowsCmdSafeTokens` guard rejects the `&` and `"` the raw relay script contains.
  const wrapped = wrapWindowsStartWait(powershell, [
    '-NoLogo',
    '-NoProfile',
    '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64')
  ])
  let exitCode: number | null = null
  const captureExitCode = (): number | null => (exitCode ??= readExitCodeFile(exitFilePath))
  return {
    command: wrapped.spawnCmd,
    args: wrapped.spawnArgs,
    stdio: 'ignore',
    windowsHide: true,
    cleanup: () => {
      // Completion handlers run after cleanup, so preserve the CLI verdict first.
      captureExitCode()
      for (const relayPath of [pidFilePath, exitFilePath]) {
        try {
          rmSync(relayPath, { force: true })
        } catch {
          // A locked relay file must not replace the login result.
        }
      }
    },
    getExitCode: captureExitCode,
    getTerminationPid: () => readPidFile(pidFilePath),
    waitForTerminationPid: () => waitForPidFile(pidFilePath)
  }
}
