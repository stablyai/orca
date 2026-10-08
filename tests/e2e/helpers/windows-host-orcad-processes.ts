/**
 * The managed server's processes on a Windows host-cell account, observed from the runner that
 * provisioned it: the lane's sshd listens on 127.0.0.1, so the account's processes are local here.
 */
import path from 'node:path'
import { runProcess } from '../../../src/shared/child-process/run-process'

export type HostProcess = { pid: number; commandLine: string }

const POWERSHELL = path.join(
  process.env.SystemRoot ?? 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe'
)

// Why ExecutablePath: orcad runs on the pinned node.exe staged under the account's home.
const LIST_SCRIPT =
  "$h=$env:ORCA_E2E_HOST_HOME.TrimEnd('\\','/')+'\\';" +
  '@(Get-CimInstance Win32_Process | Where-Object {$_.ExecutablePath -and $_.ExecutablePath.StartsWith($h,[StringComparison]::OrdinalIgnoreCase)} | ForEach-Object {@{pid=[int]$_.ProcessId;commandLine=[string]$_.CommandLine}}) | ConvertTo-Json -Compress -Depth 3'

async function powershell(script: string, home: string): Promise<string> {
  const result = await runProcess({
    program: POWERSHELL,
    args: ['-NoProfile', '-NonInteractive', '-Command', script],
    env: { ...process.env, ORCA_E2E_HOST_HOME: home.replaceAll('/', '\\') },
    timeoutMs: 60_000
  })
  if (result.code !== 0) {
    throw new Error(`Host process query failed (${result.code}): ${result.stderr.slice(0, 2_000)}`)
  }
  return result.stdout.trim()
}

export async function listHostAccountProcesses(home: string): Promise<HostProcess[]> {
  const text = await powershell(LIST_SCRIPT, home)
  if (!text) {
    return []
  }
  const parsed: unknown = JSON.parse(text)
  const rows = Array.isArray(parsed) ? parsed : [parsed]
  return rows.flatMap((row) =>
    row && typeof row.pid === 'number'
      ? [{ pid: row.pid, commandLine: String(row.commandLine ?? '') }]
      : []
  )
}

export async function listHostOrcadProcesses(home: string): Promise<HostProcess[]> {
  return (await listHostAccountProcesses(home)).filter((entry) => /orcad/iu.test(entry.commandLine))
}

/** The orcad server itself, without the terminal daemon and workers it forks from the same slot. */
export async function listHostOrcadServerProcesses(home: string): Promise<HostProcess[]> {
  return (await listHostOrcadProcesses(home)).filter((entry) =>
    /[\\/]orcad\.js(?=["\s]|$)/iu.test(entry.commandLine)
  )
}

/** Hard-kills the account's orcad server, as a crash would; its terminal daemon keeps running. */
export async function killHostOrcad(home: string): Promise<HostProcess[]> {
  const victims = await listHostOrcadServerProcesses(home)
  if (victims.length > 0) {
    await powershell(
      `Stop-Process -Force -ErrorAction SilentlyContinue -Id ${victims.map((entry) => entry.pid).join(',')}`,
      home
    )
  }
  return victims
}
