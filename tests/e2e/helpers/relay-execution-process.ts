import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { spawnProcess } from '../../../src/shared/child-process/run-process'

const executionProgram = `
const fs = require('node:fs');
const readline = require('node:readline');
const marker = process.argv[1];
let sequence = 0;
readline.createInterface({ input: process.stdin }).on('line', line => {
  const { id, value } = JSON.parse(line);
  if (value === 'mutation-1') fs.appendFileSync('mutations.log', marker + '\\n');
  process.stdout.write(JSON.stringify({ id, pid: process.pid, cwd: fs.realpathSync('.'),
    marker, sequence: ++sequence, value }) + '\\n');
});
`

export async function createRelayExecutionProcess() {
  await mkdir(path.join(process.cwd(), '.tmp'), { recursive: true })
  const folder = await mkdtemp(path.join(process.cwd(), '.tmp', 'relay-execution-'))
  const executionCwd = await realpath(folder)
  const marker = randomUUID()
  const pending = new Map<
    number,
    {
      resolve: (value: string) => void
      reject: (error: Error) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  let sequence = 0
  let nextId = 0
  let failure: Error | null = null
  const child = spawnProcess({
    program: process.execPath,
    args: ['-e', executionProgram, marker],
    cwd: folder,
    env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' }
  })
  const fail = (error: Error) => {
    failure = error
    for (const item of pending.values()) {
      clearTimeout(item.timer)
      item.reject(error)
    }
    pending.clear()
  }
  child.on('error', fail)
  child.stdin.on('error', fail)
  child.stdout.on('error', fail)
  child.stderr.on('error', fail)
  child.stderr.resume()
  const closed = new Promise<void>((resolve) =>
    child.once('close', () => {
      fail(new Error('execution process exited'))
      resolve()
    })
  )
  const lines = createInterface({ input: child.stdout })
  lines.on('line', (line) => {
    try {
      const output = JSON.parse(line)
      const item = pending.get(output.id)
      if (
        !item ||
        output.pid !== child.pid ||
        output.cwd !== executionCwd ||
        output.marker !== marker ||
        output.sequence !== sequence + 1
      ) {
        throw new Error('execution ownership or output sequence changed')
      }
      sequence = output.sequence
      clearTimeout(item.timer)
      pending.delete(output.id)
      item.resolve(output.value)
    } catch (error) {
      fail(error as Error)
    }
  })
  return {
    pid: child.pid,
    sequence: () => sequence,
    execute: (value: string) =>
      new Promise<string>((resolve, reject) => {
        if (failure) {
          reject(failure)
          return
        }
        const id = ++nextId
        const timer = setTimeout(() => fail(new Error('execution response timed out')), 5_000)
        pending.set(id, { resolve, reject, timer })
        child.stdin.write(`${JSON.stringify({ id, value })}\n`)
      }),
    mutations: async () => {
      try {
        const entries = (await readFile(path.join(folder, 'mutations.log'), 'utf8'))
          .trim()
          .split('\n')
        if (entries.some((entry) => entry !== marker)) {
          throw new Error('unexpected execution artifact')
        }
        return entries.length
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return 0
        }
        throw error
      }
    },
    close: async () => {
      child.stdin.end()
      const timer = setTimeout(() => child.kill('SIGKILL'), 5_000)
      try {
        await closed
      } finally {
        clearTimeout(timer)
        lines.close()
        await rm(folder, { recursive: true, force: true })
      }
    }
  }
}
