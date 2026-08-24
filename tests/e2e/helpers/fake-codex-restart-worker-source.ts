import { FAKE_AGENT_PASTE_END_SCANNER_SOURCE } from './fake-agent-paste-end-scanner'

export const FAKE_CODEX_RESTART_WORKER_SOURCE = `
const { appendFileSync } = require('node:fs')
const { spawnSync } = require('node:child_process')
function appendLedger(envName, event) {
  const ledgerPath = process.env[envName]
  if (!ledgerPath) return
  try {
    appendFileSync(ledgerPath, JSON.stringify({ pid: process.pid, at: Date.now(), ...event }) + '\\n')
  } catch {}
}
async function emitAuthorityHook(hookEventName) {
  const port = process.env.ORCA_AGENT_HOOK_PORT
  const token = process.env.ORCA_AGENT_HOOK_TOKEN
  const launchToken = process.env.ORCA_AGENT_LAUNCH_TOKEN
  if (!port || !token || !launchToken || !process.env.ORCA_PANE_KEY) return
  try {
    const response = await fetch('http://127.0.0.1:' + port + '/hook/codex', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Orca-Agent-Hook-Token': token
      },
      body: JSON.stringify({
        paneKey: process.env.ORCA_PANE_KEY,
        tabId: process.env.ORCA_TAB_ID,
        worktreeId: process.env.ORCA_WORKTREE_ID,
        env: process.env.ORCA_AGENT_HOOK_ENV,
        version: process.env.ORCA_AGENT_HOOK_VERSION,
        launchToken,
        payload: {
          hook_event_name: hookEventName,
          prompt: 'Respond ACK and remain idle'
        }
      })
    })
    appendLedger('ORCA_E2E_AUTHORITY_LEDGER', {
      event: 'authority-hook',
      hookEventName,
      status: response.status
    })
  } catch (error) {
    appendLedger('ORCA_E2E_AUTHORITY_LEDGER', {
      event: 'authority-hook-error',
      error: error instanceof Error ? error.message : String(error)
    })
  }
}
if (process.argv.slice(2).includes('app-server')) {
  process.stderr.write("error: unrecognized subcommand 'app-server'\\n")
  process.exit(2)
}
appendLedger('ORCA_E2E_SPAWN_LEDGER', { event: 'spawn', argv: process.argv.slice(2) })
process.stdout.write('\\u001b]0;Codex Ready\\u0007OpenAI Codex\\nmodel: e2e\\ndirectory: e2e\\n')
const sessionStartHook = emitAuthorityHook('SessionStart')
let acknowledged = false
let lifecycleSent = false
${FAKE_AGENT_PASTE_END_SCANNER_SOURCE}
process.stdin.on('data', (chunk) => {
  const input = chunk.toString()
  const pasteEndScan = scanFakeAgentPasteEnd(fakeAgentPasteEndTail, input)
  fakeAgentPasteEndTail = pasteEndScan.tail
  if (pasteEndScan.pasteEndOffset !== null) {
    process.stdout.write('\\x1b[?25h')
  }
  if (input.includes('\\x03')) {
    appendLedger('ORCA_E2E_INTERRUPTION_LEDGER', { event: 'stdin-ctrl-c' })
  }
  if (!acknowledged) {
    fakeAgentMaybeAck(pasteEndScan, input, (mode) => {
      acknowledged = true
      void sessionStartHook.then(() => emitAuthorityHook('UserPromptSubmit'))
      const message = mode === 'bracketed' ? 'ACK' : 'PASTE_PROTOCOL_ERROR'
      process.stdout.write('\\u001b]0;Codex Working\\u0007' + message + '\\n')
      setTimeout(() => process.stdout.write('\\u001b]0;Codex Ready\\u0007'), 10)
    })
  }
  const legacyCompletion = input.match(/ORCA_E2E_RUN_LEGACY_DONE:([A-Za-z0-9+/=]+)/)
  if (!lifecycleSent && legacyCompletion) {
    lifecycleSent = true
    const identity = JSON.parse(Buffer.from(legacyCompletion[1], 'base64').toString('utf8'))
    const cliEntry = process.env.ORCA_E2E_CLI_ENTRY
    const args = [
      'orchestration',
      'send',
      '--to',
      identity.coordinatorHandle,
      '--type',
      'worker_done',
      '--subject',
      'Completed',
      '--body',
      'E2E retained legacy completion',
      '--payload',
      JSON.stringify({
        taskId: identity.taskId,
        dispatchId: identity.dispatchId,
        filesModified: []
      }),
      '--json'
    ]
    const result = cliEntry
      ? spawnSync(process.execPath, [cliEntry, ...args], {
          env: process.env,
          encoding: 'utf8'
        })
      : { status: 127, stdout: '', stderr: 'ORCA_E2E_CLI_ENTRY missing' }
    appendLedger('ORCA_E2E_LIFECYCLE_LEDGER', {
      event: 'legacy-command',
      argv: args,
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr
    })
    process.stdout.write(String(result.stdout || '') + String(result.stderr || ''))
  }
})
process.stdin.setRawMode?.(true)
for (const signal of ['SIGINT', 'SIGHUP', 'SIGTERM']) {
  process.on(signal, () => {
    appendLedger('ORCA_E2E_INTERRUPTION_LEDGER', { event: 'signal', signal })
    process.exit(0)
  })
}
process.stdin.resume()
setInterval(() => {}, 60_000)
`
