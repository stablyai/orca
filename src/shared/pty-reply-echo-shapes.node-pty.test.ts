/**
 * Keeps the transcript in pty-startup-reply-echo-shapes.test.ts honest.
 *
 * That file asserts against echo bytes recorded by hand, which is exactly how the two
 * shapes this PR corrected went wrong in the first place: the projection and the test both
 * encoded the same guess. This one writes a reply to a real PTY master, reads what bash
 * actually echoes, and feeds it to the projection — so a shell or libc change that moves
 * the shape fails here instead of silently disarming suppression.
 *
 * Two line disciplines, because they echo differently and both are reachable:
 *   readline — tty raw at a prompt, readline echoes in software
 *   cooked   — under `read`, the kernel echoes via ECHOCTL
 */
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

/**
 * Writes `reply` to the master once bash is settled, and returns what came back.
 * `discipline: 'cooked'` parks bash in `read` first, which restores ICANON+ECHO.
 */
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
  // The reachable fix: a latched mode-2031 push echoed at a readline prompt had no
  // projection at all before this, so it always painted `997;1n` on the prompt (#9993).
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

  // The ST form is what every in-tree OSC reply uses, so this is the shape that must never
  // regress — the BEL form is only reachable from a foreign or older emulator.
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
