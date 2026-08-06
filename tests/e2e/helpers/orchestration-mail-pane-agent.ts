/**
 * A scriptable stand-in for the `codex` CLI, for orchestration push-delivery E2E.
 *
 * Why a fake agent binary and not a bare shell emitting titles: push-on-idle is
 * gated on the status Orca infers from live OSC titles and delivers by writing
 * into the pane's foreground process. A shell echoes rather than records, so it
 * can prove the gate but never the payload. This process owns both sides — the
 * test drives its title through a control file and it appends every stdin chunk
 * to a ledger, which is what makes "the banner and the Enter actually reached
 * the agent" an assertion instead of an inference.
 *
 * Titles come from a polled file, not stdin, because orchestration writes to
 * stdin itself; a stdin control channel could not tell a test command apart from
 * the delivery under test. Both files are keyed by ORCA_TERMINAL_HANDLE so panes
 * in the same spec never share a ledger.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** `detectAgentStatusFromTitle` reads these as agent-name + strong keyword. */
export const CODEX_IDLE_TITLE = 'Codex done'
export const CODEX_WORKING_TITLE = 'Codex working'
/** Also satisfies `isCursorAgentTitle`, which suppresses the synthesized Enter. */
export const CURSOR_IDLE_TITLE = 'Cursor Ready'

export type AgentLedgerEntry = {
  pid: number
  at: number
  event: 'start' | 'stdin' | 'title'
  handle?: string | null
  data?: string
  title?: string
}

const AGENT_SOURCE = `
const { appendFileSync, existsSync, readFileSync, statSync } = require('node:fs')
const path = require('node:path')

// Orca probes for the modern protocol before falling back to the TUI; the real
// CLI fails this the same way, and answering it would strand the pane.
if (process.argv.slice(2).includes('app-server')) {
  process.stderr.write("error: unrecognized subcommand 'app-server'\\n")
  process.exit(2)
}

const dir = process.env.ORCA_E2E_MAIL_AGENT_DIR
const handle = process.env.ORCA_TERMINAL_HANDLE || 'unknown'
const ledgerPath = path.join(dir, handle + '.jsonl')
const controlPath = path.join(dir, handle + '.title')

function log(entry) {
  try {
    appendFileSync(ledgerPath, JSON.stringify({ pid: process.pid, at: Date.now(), ...entry }) + '\\n')
  } catch {}
}

log({ event: 'start', handle })
process.stdout.write('OpenAI Codex\\nmodel: e2e\\ndirectory: e2e\\n')

// Raw mode is what every agent TUI does, and it is load-bearing here: a cooked
// PTY applies ICRNL, so the synthesized Enter would arrive as \\n and be
// indistinguishable from the banner's own newlines.
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true)
}

// Every byte orchestration pushes lands here — banner text and Enter alike.
process.stdin.on('data', (chunk) => log({ event: 'stdin', data: chunk.toString() }))
process.stdin.resume()

// No title is emitted until the test asks for one, so a pane can be held in the
// "no live agent status yet" state the seeded-restore cases depend on.
// Keyed on mtime rather than content so a test can re-emit the SAME title — a
// restored pane already reads idle, and proving it needed a LIVE frame means
// emitting that same idle again.
let lastStamp = null
setInterval(() => {
  if (!existsSync(controlPath)) return
  let title
  let stamp
  try {
    stamp = statSync(controlPath).mtimeMs
    if (stamp === lastStamp) return
    title = readFileSync(controlPath, 'utf8').trim()
  } catch {
    return
  }
  if (!title) return
  lastStamp = stamp
  process.stdout.write('\\u001b]0;' + title + '\\u0007')
  log({ event: 'title', title })
}, 50)

setInterval(() => {}, 60_000)
`

const fakeCliDir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-mail-cli-'))
const agentStateDir = path.join(fakeCliDir, 'state')
mkdirSync(agentStateDir, { recursive: true })

if (process.platform === 'win32') {
  writeFileSync(path.join(fakeCliDir, 'fake-codex.js'), AGENT_SOURCE)
  writeFileSync(
    path.join(fakeCliDir, 'codex.cmd'),
    '@echo off\r\nnode "%~dp0\\fake-codex.js" %*\r\n'
  )
} else {
  const executable = path.join(fakeCliDir, 'codex')
  writeFileSync(executable, `#!/usr/bin/env node\n${AGENT_SOURCE}`)
  chmodSync(executable, 0o755)
}

/** Spread into the `launchEnv` fixture so every PTY the app spawns finds it. */
export const MAIL_AGENT_LAUNCH_ENV: Record<string, string> = {
  PATH: `${fakeCliDir}${path.delimiter}${process.env.PATH ?? ''}`,
  ORCA_E2E_MAIL_AGENT_DIR: agentStateDir
}

// Why worker exit and not a spec's afterAll: Playwright reuses a worker across
// spec files, so this module is one instance shared by every spec in it. An
// afterAll teardown would delete the CLI out from under a spec that has not run
// yet — which surfaces as a fake agent that mysteriously never starts.
process.once('exit', () => {
  rmSync(fakeCliDir, { recursive: true, force: true })
})

export type MailPaneAgent = {
  /** Emit `title` as an OSC title from the live process. */
  setTitle: (title: string) => void
  readLedger: () => AgentLedgerEntry[]
  /** Concatenated stdin — what the agent actually received. */
  readStdin: () => string
  hasStarted: () => boolean
  /** Emitted-title count; the readiness signal when a title is re-sent as-is. */
  titleEmitCount: () => number
}

/** Observation handle for the agent running in the pane addressed by `handle`. */
export function mailPaneAgent(handle: string): MailPaneAgent {
  const ledgerPath = path.join(agentStateDir, `${handle}.jsonl`)
  const controlPath = path.join(agentStateDir, `${handle}.title`)

  const readLedger = (): AgentLedgerEntry[] => {
    if (!existsSync(ledgerPath)) {
      return []
    }
    return readFileSync(ledgerPath, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as AgentLedgerEntry]
        } catch {
          // A torn final line just means the agent is mid-append; the poll retries.
          return []
        }
      })
  }

  return {
    setTitle: (title: string) => writeFileSync(controlPath, title),
    readLedger,
    readStdin: () =>
      readLedger()
        .filter((entry) => entry.event === 'stdin')
        .map((entry) => entry.data ?? '')
        .join(''),
    hasStarted: () => readLedger().some((entry) => entry.event === 'start'),
    titleEmitCount: () => readLedger().filter((entry) => entry.event === 'title').length
  }
}
