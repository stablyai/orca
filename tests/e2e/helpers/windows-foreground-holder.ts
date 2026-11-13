// A test-owned Windows window that holds the real foreground the way the user's own app would.

import { execFile, spawn } from 'node:child_process'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const holderScript = join(process.cwd(), 'tests/e2e/helpers/windows-foreground-holder.ps1')
const REPLY_TIMEOUT_MS = 15_000

export type WindowsForegroundHolder = {
  /** Activates the holder and lifts the foreground lock, so an Orca activation attempt would succeed. */
  take: () => Promise<void>
  /** Which window has the real foreground: the holder, or another process by pid. */
  foreground: () => Promise<{ holder: boolean; pid: number }>
  /** Presses one key through the OS input queue, so it reaches whichever window is in front. */
  press: (key: string) => Promise<void>
  close: () => Promise<void>
}

export async function startWindowsForegroundHolder(): Promise<WindowsForegroundHolder> {
  // Why: no windowsHide; Node's hidden startup flag would also hide the holder's form.
  const child = spawn(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-STA',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      holderScript,
      '-Title',
      `Orca focus holder ${Date.now()}`
    ],
    { stdio: ['pipe', 'pipe', 'inherit'] }
  )
  const replies: string[] = []
  const waiters: ((line: string) => void)[] = []
  createInterface({ input: child.stdout }).on('line', (line) => {
    const waiter = waiters.shift()
    if (waiter) {
      waiter(line)
    } else {
      replies.push(line)
    }
  })
  const nextReply = (label: string): Promise<string> => {
    const queued = replies.shift()
    if (queued !== undefined) {
      return Promise.resolve(queued)
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.splice(waiters.indexOf(onLine), 1)
        reject(new Error(`Windows foreground holder did not answer ${label}`))
      }, REPLY_TIMEOUT_MS)
      const onLine = (line: string): void => {
        clearTimeout(timer)
        resolve(line)
      }
      waiters.push(onLine)
    })
  }
  const send = async (command: string): Promise<string> => {
    child.stdin.write(`${command}\n`)
    const reply = await nextReply(command)
    if (reply.startsWith('error')) {
      throw new Error(`Windows foreground holder ${command}: ${reply}`)
    }
    return reply
  }
  const close = async (): Promise<void> => {
    if (child.exitCode !== null || child.pid === undefined) {
      return
    }
    try {
      await execFileAsync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'])
    } catch {
      // The holder may already have exited.
    }
  }

  try {
    const ready = await nextReply('startup')
    if (ready !== 'ready') {
      throw new Error(`Windows foreground holder failed to start: ${ready}`)
    }
  } catch (error) {
    await close()
    throw error
  }
  return {
    take: async () => {
      await send('take')
    },
    foreground: async () => {
      const [owner, pid] = (await send('foreground')).split(' ')
      return { holder: owner === 'holder', pid: Number(pid) }
    },
    press: async (key) => {
      await send(`key ${key}`)
    },
    close
  }
}
