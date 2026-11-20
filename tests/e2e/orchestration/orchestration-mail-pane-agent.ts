// Record foreground stdin and emit controlled OSC titles so idle-gated push tests prove exact delivery, not shell echo.
// Control titles via file because stdin carries the delivery under test; reuse a mounted pane to avoid unrelated handle-binding races.
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** `detectAgentStatusFromTitle` reads these as agent-name + strong keyword. */
export const CODEX_IDLE_TITLE = 'Codex done'
export const CODEX_WORKING_TITLE = 'Codex working'
/** Cursor Agent idle title (`isCursorAgentTitle`). */
export const CURSOR_IDLE_TITLE = 'Cursor Ready'

export type AgentLedgerEntry = {
  pid: number
  at: number
  event: 'start' | 'stdin' | 'title'
  data?: string
  title?: string
}

const AGENT_SOURCE = `
const { appendFileSync, existsSync, readFileSync, statSync } = require('node:fs')

const [ledgerPath, controlPath, encodedReaction] = process.argv.slice(2)
const reaction = encodedReaction
  ? JSON.parse(Buffer.from(encodedReaction, 'base64').toString('utf8'))
  : null
let reactionSeen = ''
let reacted = false

function log(entry) {
  try {
    appendFileSync(ledgerPath, JSON.stringify({ pid: process.pid, at: Date.now(), ...entry }) + '\\n')
  } catch {}
}

log({ event: 'start' })

// Raw mode is what every agent TUI does, and it is load-bearing here: a cooked
// PTY applies ICRNL, so the synthesized Enter would arrive as \\n and be
// indistinguishable from the pointer's own newlines.
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true)
}

// Every byte orchestration pushes lands here — pointer text and Enter alike.
process.stdin.on('data', (chunk) => {
  const data = chunk.toString()
  log({ event: 'stdin', data })
  if (!reaction || reacted) return
  reactionSeen = (reactionSeen + data).slice(-8192)
  if (!reactionSeen.includes(reaction.needle)) return
  reacted = true
  process.stdout.write('\\u001b]0;' + reaction.title + '\\u0007')
  log({ event: 'title', title: reaction.title })
})
process.stdin.resume()

// No title is emitted until the test asks for one, so a pane can be held in the
// "no live agent status yet" state some cases depend on. Keyed on mtime rather
// than content so a test can re-emit the SAME title: proving a restored pane
// needed a LIVE frame means sending an idle it already appears to have.
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

export type MailPaneAgent = {
  /** Shell-agnostic command that starts the agent; no trailing carriage return. */
  launchCommand: string
  /** Emit `title` as an OSC title from the live process. */
  setTitle: (title: string) => void
  readLedger: () => AgentLedgerEntry[]
  /** Concatenated stdin — what the agent actually received. */
  readStdin: () => string
  hasStarted: () => boolean
  /** Emitted-title count; the readiness signal when a title is re-sent as-is. */
  titleEmitCount: () => number
}

export type MailPaneAgentOptions = {
  titleOnStdin?: { needle: string; title: string }
  /** Agent CLI the script is named after (default codex); null models an unrecognized program. */
  executable?: 'codex' | 'cursor-agent' | null
}

// Clean up at worker exit: reused spec workers can still be polling another file’s agent ledger.
const agentDirs: string[] = []
process.once('exit', () => {
  for (const dir of agentDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
})

/** One isolated agent: its own script copy, ledger, and control file. */
export function createMailPaneAgent(options: MailPaneAgentOptions = {}): MailPaneAgent {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-mail-agent-'))
  agentDirs.push(dir)
  // Named like an npm shim (`node …/bin/codex`) so launch and foreground identity recognize the agent.
  const { executable = 'codex' } = options
  const scriptPath = path.join(dir, executable ?? 'program.cjs')
  const ledgerPath = path.join(dir, 'ledger.jsonl')
  const controlPath = path.join(dir, 'title')
  writeFileSync(scriptPath, AGENT_SOURCE)
  writeFileSync(ledgerPath, '')

  // Use forward slashes so Node paths survive PowerShell, cmd and POSIX parsing unchanged.
  const quote = (value: string): string => `"${value.replaceAll('\\', '/')}"`

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

  const encodedReaction = Buffer.from(JSON.stringify(options.titleOnStdin ?? null)).toString(
    'base64'
  )

  return {
    launchCommand: `node ${quote(scriptPath)} ${quote(ledgerPath)} ${quote(controlPath)} ${quote(encodedReaction)}`,
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
