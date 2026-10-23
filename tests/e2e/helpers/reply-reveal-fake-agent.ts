/**
 * A Claude/Codex stand-in for the reply-reveal E2E. It reads the PTY in raw mode like the real
 * TUIs and posts hook payloads in the providers' shapes: Claude submissions and stops carry
 * `prompt_id` and the transcript records `origin.kind`; Codex carries `turn_id`, and its wake turn
 * (InterAgentCommunication) sends Stop with no submission hook. The test drives turn ends and wakes
 * through a control file, so stdin carries only what the person or Orca typed. Like the real CLIs,
 * Claude reports SessionStart at launch and Codex only when its first turn starts.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export type FakeReplyAgentProvider = 'claude' | 'codex'

export type FakeReplyAgentLedgerEntry = {
  at: number
  event: string
  name?: string
  status?: number
  id?: string
  text?: string
}

const AGENT_SOURCE = String.raw`
const { appendFileSync, existsSync, readFileSync } = require('node:fs')
const { randomUUID } = require('node:crypto')
const path = require('node:path')
const [provider, dir] = process.argv.slice(2)
const sessionId = randomUUID()
const transcriptPath = path.join(dir, provider + '-' + sessionId + '.jsonl')
const ledgerPath = path.join(dir, provider + '-ledger.jsonl')
const controlPath = path.join(dir, provider + '-control.jsonl')
const ledger = (entry) => appendFileSync(ledgerPath, JSON.stringify({ at: Date.now(), ...entry }) + '\n')
const record = (entry) =>
  appendFileSync(transcriptPath, JSON.stringify({ sessionId, uuid: randomUUID(), ...entry }) + '\n')
let chain = Promise.resolve()
function hook(payload) {
  const body = {
    paneKey: process.env.ORCA_PANE_KEY,
    tabId: process.env.ORCA_TAB_ID,
    worktreeId: process.env.ORCA_WORKTREE_ID,
    launchToken: process.env.ORCA_AGENT_LAUNCH_TOKEN,
    env: process.env.ORCA_AGENT_HOOK_ENV,
    version: process.env.ORCA_AGENT_HOOK_VERSION,
    payload: { session_id: sessionId, transcript_path: transcriptPath, cwd: process.cwd(), ...payload }
  }
  chain = chain.then(() =>
    fetch('http://127.0.0.1:' + process.env.ORCA_AGENT_HOOK_PORT + '/hook/' + provider, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Orca-Agent-Hook-Token': process.env.ORCA_AGENT_HOOK_TOKEN },
      body: JSON.stringify(body)
    }).then(
      (response) => ledger({ event: 'hook', name: payload.hook_event_name, status: response.status }),
      (error) => ledger({ event: 'hook-error', name: payload.hook_event_name, text: String(error) })
    )
  )
  return chain
}
const idKey = provider === 'claude' ? 'prompt_id' : 'turn_id'
let current = null
function submitHook(id, text) {
  if (provider === 'claude') {
    record({ type: 'user', promptId: id, origin: { kind: 'human' }, message: { role: 'user', content: text } })
  }
  return hook({ hook_event_name: 'UserPromptSubmit', [idKey]: id, prompt: text })
}
function stopHook(id, reply) {
  if (provider === 'claude') {
    record({ type: 'assistant', promptId: id, message: { role: 'assistant', content: reply } })
  }
  return hook({ hook_event_name: 'Stop', [idKey]: id, last_assistant_message: reply, stop_hook_active: false })
}
function submit(raw) {
  const text = raw.trim()
  if (!text || text.startsWith('/')) {
    // Approval Enters and local slash commands submit no prompt and fire no submission hook.
    ledger({ event: text ? 'local-command' : 'bare-enter', text })
    process.stdout.write('\r\n[fake] ' + (text || 'enter') + '\r\n')
    return
  }
  if (current && provider === 'codex') {
    ledger({ event: 'steer', id: current.id, text })
    void submitHook(current.id, text)
    return
  }
  current = { id: randomUUID(), text }
  ledger({ event: 'submit', id: current.id, text })
  if (!started) {
    // Codex runs its queued SessionStart at the first turn, after the Enter and before UserPromptSubmit.
    started = true
    void hook({ hook_event_name: 'SessionStart', source: 'startup' })
  }
  process.stdout.write('\r\n[fake] working ' + text + '\r\n')
  void submitHook(current.id, text)
}
function finish() {
  if (!current) return
  const turn = current
  current = null
  ledger({ event: 'finish', id: turn.id })
  void stopHook(turn.id, 'Reply to ' + turn.text).then(() => process.stdout.write('[fake] done\r\n'))
}
function wake() {
  const id = randomUUID()
  ledger({ event: 'wake', id })
  if (provider === 'claude') {
    // Claude opens a task-notification turn with a submission hook but a non-human origin.
    const text = '<task-notification>background job finished</task-notification>'
    record({ type: 'user', promptId: id, origin: { kind: 'task-notification' }, message: { role: 'user', content: text } })
    void hook({ hook_event_name: 'UserPromptSubmit', prompt_id: id, prompt: text })
  } else {
    // Codex opens a mail-woken turn with no submission hook; its first tool call marks it working.
    void hook({ hook_event_name: 'PreToolUse', turn_id: id, tool_name: 'shell', tool_input: { command: 'ls' } })
  }
  void stopHook(id, 'Woke up and reported')
}
function compact() {
  if (!current || provider !== 'claude') return
  // Claude's auto-compaction mid-turn: a summary under the same prompt id, then SessionStart(compact).
  ledger({ event: 'compact', id: current.id })
  record({ type: 'user', promptId: current.id, isCompactSummary: true, message: { role: 'user', content: 'summary' } })
  void hook({ hook_event_name: 'SessionStart', source: 'compact' })
}
let buffer = ''
let inPaste = false
let pending = ''
process.stdin.setRawMode(true)
process.stdout.write('\x1b[?2004h[fake] ' + provider + ' ready\r\n')
process.stdin.on('data', (chunk) => {
  const data = pending + chunk.toString('utf8')
  pending = ''
  ledger({ event: 'stdin', text: data })
  for (let i = 0; i < data.length; i += 1) {
    if (data.startsWith('\x1b[200~', i)) { inPaste = true; i += 5; continue }
    if (data.startsWith('\x1b[201~', i)) { inPaste = false; i += 5; continue }
    const char = data[i]
    if (char === '\x1b') {
      if (i + 6 > data.length && '\x1b[200~'.startsWith(data.slice(i))) { pending = data.slice(i); break }
      let end = i + 1
      if (data[end] === '[') { end += 1; while (end < data.length && !/[@-~]/.test(data[end])) end += 1 }
      i = end
      continue
    }
    if (char === '\r' && !inPaste) { const line = buffer; buffer = ''; submit(line); continue }
    if (char === '\x7f') { buffer = buffer.slice(0, -1); continue }
    if (char >= ' ' || char === '\n' || char === '\r') buffer += char
  }
})
let handled = 0
setInterval(() => {
  if (!existsSync(controlPath)) return
  const lines = readFileSync(controlPath, 'utf8').split('\n').filter(Boolean)
  for (; handled < lines.length; handled += 1) {
    const command = JSON.parse(lines[handled]).command
    if (command === 'finish') finish()
    else if (command === 'wake') wake()
    else if (command === 'compact') compact()
    else if (command === 'exit') process.exit(0)
  }
}, 50)
// Claude reports SessionStart at launch; Codex defers it to the first turn (codex-rs session/turn.rs).
let started = provider === 'claude'
if (started) void hook({ hook_event_name: 'SessionStart', source: 'startup' })
`

export function writeFakeReplyAgent(dir: string): string {
  const scriptPath = path.join(dir, 'fake-reply-agent.cjs')
  writeFileSync(scriptPath, AGENT_SOURCE)
  return scriptPath
}

export function controlFakeReplyAgent(
  dir: string,
  provider: FakeReplyAgentProvider,
  command: 'finish' | 'wake' | 'compact' | 'exit'
): void {
  appendFileSync(path.join(dir, `${provider}-control.jsonl`), `${JSON.stringify({ command })}\n`)
}

export function readFakeReplyAgentLedger(
  dir: string,
  provider: FakeReplyAgentProvider
): FakeReplyAgentLedgerEntry[] {
  const ledgerPath = path.join(dir, `${provider}-ledger.jsonl`)
  if (!existsSync(ledgerPath)) {
    return []
  }
  return readFileSync(ledgerPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line): FakeReplyAgentLedgerEntry => JSON.parse(line))
}

/** Count of 204-accepted hooks of one name, so a test can wait for Orca to have received them. */
export function countAcceptedFakeReplyHooks(
  dir: string,
  provider: FakeReplyAgentProvider,
  name: string
): number {
  return readFakeReplyAgentLedger(dir, provider).filter(
    (entry) => entry.event === 'hook' && entry.name === name && entry.status === 204
  ).length
}

/** Everything the PTY delivered to the agent, in order. */
export function readFakeReplyAgentStdin(dir: string, provider: FakeReplyAgentProvider): string {
  return readFakeReplyAgentLedger(dir, provider)
    .filter((entry) => entry.event === 'stdin')
    .map((entry) => entry.text ?? '')
    .join('')
}
