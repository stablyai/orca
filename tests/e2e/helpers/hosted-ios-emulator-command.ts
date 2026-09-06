import { spawn, type ChildProcess } from 'node:child_process'

export type HostedIosEmulatorCommandOptions = {
  deviceUdid: string
  orcaCli: string
  userDataDir: string
  worktree: string
}

export function runHostedIosEmulatorCommand(
  args: HostedIosEmulatorCommandOptions,
  command: string[]
): Promise<{ stderr: string; stdout: string }> {
  const argv = [
    'emulator',
    ...command,
    '--device',
    args.deviceUdid,
    '--worktree',
    `path:${args.worktree}`,
    '--json'
  ]
  return new Promise((resolve, reject) => {
    const child = spawn(args.orcaCli, argv, {
      cwd: args.worktree,
      detached: true,
      env: {
        ...process.env,
        ORCA_DEV_USER_DATA_PATH: args.userDataDir,
        ORCA_USER_DATA_PATH: args.userDataDir
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let settled = false
    let stderr = ''
    let stdout = ''
    const timer = setTimeout(() => {
      killProcessGroup(child)
      finish(new Error(`Orca emulator command timed out: ${command[0] ?? 'unknown'}`))
    }, 30_000)
    const finish = (error?: Error) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      if (error) {
        reject(error)
      } else {
        resolve({ stderr, stdout })
      }
    }
    const append = (current: string, chunk: Buffer): string => {
      const next = current + String(chunk)
      if (Buffer.byteLength(next) > 2 * 1024 * 1024) {
        killProcessGroup(child)
        finish(new Error('Orca emulator command exceeded its output limit'))
        return current
      }
      return next
    }
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = append(stdout, chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = append(stderr, chunk)
    })
    child.once('error', (error) => finish(error))
    child.once('close', (code, signal) => {
      if (code === 0) {
        finish()
      } else {
        finish(
          new Error(
            `Orca emulator command failed (${code ?? signal ?? 'unknown'}): ${stderr || stdout}`
          )
        )
      }
    })
  })
}

function killProcessGroup(child: ChildProcess): void {
  if (!child.pid) {
    return
  }
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    child.kill('SIGKILL')
  }
}
