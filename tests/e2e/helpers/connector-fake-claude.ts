// A scripted Claude for connector E2E: real managed hooks, Claude's OSC 7501 activity reports, no model.
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { getManagedScript } from '../../../src/main/claude/hook-script'

/** A message containing this asks for Bash approval, as in the captured approve/deny transcript. */
export const FAKE_CLAUDE_NEEDS_APPROVAL = '[needs-approval]'
/** A message containing this keeps the turn running until Escape. */
export const FAKE_CLAUDE_KEEPS_WORKING = '[keeps-working]'

/**
 * Hook payloads follow src/shared/__fixtures__/claude-permission-approve-deny-hooks.jsonl and
 * claude-cancel-shell-hooks.jsonl: approval is PreToolUse then PermissionRequest; allow ends with
 * PostToolUse then Stop; a rejection or an Escape fires no hook, only Claude's own idle report.
 */
const FAKE_CLAUDE_SOURCE = `
const { appendFileSync } = require('node:fs')
const { spawnSync } = require('node:child_process')
const log = (line) => appendFileSync(ledgerPath, line + '\\n')
const activity = (state) => process.stdout.write('\\x1b]7501;state=' + state + ':app=claude-code\\x1b\\\\')
const hook = (name, extra) =>
  spawnSync('sh', [hookScript], {
    input: JSON.stringify({ session_id: 'connector-e2e', cwd: process.cwd(), hook_event_name: name, ...extra }),
    env: process.env
  })
const bash = { tool_name: 'Bash', tool_input: { command: 'touch approved.txt' } }
let state = 'idle'
const idle = () => {
  state = 'idle'
  activity('idle')
  process.stdout.write('\\r\\n\\u276f ')
}
const finish = (message) => {
  process.stdout.write('\\r\\n' + message + '\\r\\n')
  hook('Stop', { last_assistant_message: message })
  idle()
}
const turn = (text) => {
  state = 'working'
  activity('working')
  hook('UserPromptSubmit', { prompt: text })
  // Logged after the hook returns, so a reader of the ledger knows the host has the turn.
  log('turn:' + text)
  if (text.includes(${JSON.stringify(FAKE_CLAUDE_NEEDS_APPROVAL)})) {
    hook('PreToolUse', { ...bash, tool_use_id: 'toolu_e2e' })
    hook('PermissionRequest', bash)
    state = 'approval'
    activity('blocked')
    process.stdout.write('\\r\\nBash command\\r\\n  touch approved.txt\\r\\nDo you want to proceed?\\r\\n\\u276f 1. Yes\\r\\n  2. No\\r\\n')
  } else if (!text.includes(${JSON.stringify(FAKE_CLAUDE_KEEPS_WORKING)})) {
    finish('REPLY ' + text)
  }
}
let pending = ''
process.stdin.on('data', (chunk) => {
  const data = chunk.toString('utf8')
  log('keys:' + JSON.stringify(data))
  if (state === 'approval' && data === '1') {
    log('approved')
    hook('PostToolUse', { ...bash, tool_use_id: 'toolu_e2e', tool_response: { stdout: '' } })
    return finish('APPROVED')
  }
  if (state !== 'idle' && data === '\\x1b') {
    log(state === 'approval' ? 'rejected' : 'interrupted')
    process.stdout.write('\\r\\nInterrupted\\r\\n')
    return idle()
  }
  // Show the cursor once a paste lands, so the writer's render gate settles before its 8 s cap.
  if ((pending.slice(-5) + data).includes('\\x1b[201~')) {
    process.stdout.write('\\x1b[?25h')
  }
  pending += data
  // Claude submits a bracketed paste on the Enter that follows it.
  const submitted = /\\x1b\\[200~([\\s\\S]*?)\\x1b\\[201~\\r/.exec(pending)
  if (submitted) {
    pending = pending.slice(submitted.index + submitted[0].length)
    turn(submitted[1])
  }
})
process.stdin.setRawMode?.(true)
process.stdin.resume()
hook('SessionStart', { source: 'startup' })
process.stdout.write('Claude Code (connector e2e)\\r\\n')
const argvPrompt = process.argv.slice(2).filter((arg) => !arg.startsWith('-')).pop()
if (argvPrompt) {
  turn(argvPrompt)
} else {
  idle()
}
`

export type FakeClaude = {
  /** The command for settings.mutateAgentLaunch's claude override. */
  command: string
  /** One line per event: `turn:<text>`, `keys:<JSON of the bytes read>`, approved, rejected, interrupted. */
  ledger: () => string[]
}

export function writeFakeClaude(dir: string): FakeClaude {
  const hookScript = path.join(dir, 'claude-hook.sh')
  writeFileSync(hookScript, getManagedScript('posix'))
  chmodSync(hookScript, 0o755)
  const ledgerPath = path.join(dir, 'claude-ledger.txt')
  const command = path.join(dir, 'claude')
  const paths = `const [ledgerPath, hookScript] = ${JSON.stringify([ledgerPath, hookScript])}`
  writeFileSync(command, `#!${process.execPath}\n${paths}\n${FAKE_CLAUDE_SOURCE}`)
  chmodSync(command, 0o755)
  return {
    command,
    ledger: () =>
      existsSync(ledgerPath) ? readFileSync(ledgerPath, 'utf8').split('\n').filter(Boolean) : []
  }
}
