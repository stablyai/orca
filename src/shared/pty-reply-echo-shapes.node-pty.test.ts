/** Capture actual bash PTY echoes to independently validate hand-transcribed projection fixtures. Exercise both raw readline
 * software echoes and cooked read/kernel ECHOCTL; guessed fixtures previously mirrored the implementation’s errors. */
import { existsSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { locateEcho, replyEchoProjections } from './pty-startup-reply-echo-shapes'
import { mode2031SequenceFor } from './terminal-color-scheme-protocol'

const BASH = '/bin/bash'
const itWithBash = process.platform !== 'win32' && existsSync(BASH) ? it : it.skip

const COLOR_SCHEME_REPLY = mode2031SequenceFor('dark')
const OSC_COLOR_REPLY_ST = '\x1b]11;rgb:2e2e/3434/3434\x1b\\'

type Pty = { write: (data: string) => void; kill: () => void }

let live: Pty | null = null

afterEach(() => {
  live?.kill()
  live = null
})

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline && !predicate()) {
    await sleep(25)
  }
}

/** Capture settled bash’s echo after a master write; cooked parks it in read (ICANON+ECHO). */
async function echoOf(reply: string, discipline: 'readline' | 'cooked'): Promise<string> {
  const { spawn } = await import('node-pty')
  let output = ''
  const pty = spawn(BASH, ['--norc', '--noprofile', '-i'], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    env: { ...process.env, PS1: 'ORCA16542> ', TERM: 'xterm-256color' }
  })
  live = { write: (data) => pty.write(data), kill: () => pty.kill() }
  pty.onData((data) => {
    output += data
  })

  await waitFor(() => output.includes('ORCA16542> '), 10_000)
  if (discipline === 'cooked') {
    pty.write('read -r ORCA_LINE\r')
    await sleep(400)
  }
  output = ''
  pty.write(reply)
  // No marker to wait on: the echo is all this produces, so settle instead.
  await waitFor(() => output.length > 0, 5_000)
  await sleep(250)
  return output
}

describe('replyEchoProjections against a real bash pty', () => {
  // Readline mode-2031 echoes previously lacked any projection and leaked 997;1n onto the prompt (#9993).
  itWithBash(
    'matches what readline echoes for a mode-2031 reply',
    async () => {
      const echo = await echoOf(COLOR_SCHEME_REPLY, 'readline')
      expect(echo).not.toBe('')
      const match = locateEcho(replyEchoProjections(COLOR_SCHEME_REPLY, 'posix-pty'), echo)
      expect(match).toMatchObject({ kind: 'complete' })
    },
    30_000
  )

  itWithBash(
    'matches what the kernel echoes for a mode-2031 reply',
    async () => {
      const echo = await echoOf(COLOR_SCHEME_REPLY, 'cooked')
      expect(echo).not.toBe('')
      const match = locateEcho(replyEchoProjections(COLOR_SCHEME_REPLY, 'posix-pty'), echo)
      expect(match).toMatchObject({ kind: 'complete' })
    },
    30_000
  )

  // In-tree OSC replies use ST; BEL is only reachable from older/foreign emulators.
  itWithBash(
    'matches what the kernel echoes for an ST-terminated OSC reply',
    async () => {
      const echo = await echoOf(OSC_COLOR_REPLY_ST, 'cooked')
      expect(echo).not.toBe('')
      const match = locateEcho(replyEchoProjections(OSC_COLOR_REPLY_ST, 'posix-pty'), echo)
      expect(match).toMatchObject({ kind: 'complete' })
    },
    30_000
  )

  itWithBash(
    'matches what readline echoes for an ST-terminated OSC reply',
    async () => {
      const echo = await echoOf(OSC_COLOR_REPLY_ST, 'readline')
      expect(echo).not.toBe('')
      const match = locateEcho(replyEchoProjections(OSC_COLOR_REPLY_ST, 'posix-pty'), echo)
      expect(match).toMatchObject({ kind: 'complete' })
    },
    30_000
  )
})
