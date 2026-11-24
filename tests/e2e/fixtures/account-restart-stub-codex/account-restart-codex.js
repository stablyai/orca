#!/usr/bin/env node
// Stand-in Codex for the account restart E2E. It records each launch (CODEX_HOME and argv), keeps one
// rollout per thread under CODEX_HOME, reports that thread to Orca's hook server like Codex's hooks,
// and echoes submitted input so the spec can see which process receives keystrokes.
const fs = require('node:fs')
const path = require('node:path')

const READY_MARKER = 'ACCOUNT_RESTART_STUB_READY'
const SUBMITTED_MARKER = 'ACCOUNT_RESTART_STUB_SUBMITTED'
const ROLLOUT_DAY = path.join('2026', '11', '24')

const argv = process.argv.slice(2)
// Orca probes agent CLIs (version, app-server); answer them without counting a launch.
if (argv.includes('--version') || argv.includes('-V')) {
  process.stdout.write('codex-cli 0.0.0-e2e\n')
  process.exit(0)
}
if (argv[0] === 'app-server') {
  process.stderr.write("error: unrecognized subcommand 'app-server'\n")
  process.exit(2)
}
// Only an interactive pane launch has a terminal; any other probe is not a Codex session.
if (!process.stdin.isTTY) {
  process.exit(0)
}
const resumeIndex = argv.indexOf('resume')
const threadId =
  resumeIndex !== -1 && argv[resumeIndex + 1]
    ? argv[resumeIndex + 1]
    : process.env.ORCA_E2E_RESTART_THREAD_ID || '00000000-0000-4000-8000-0000000000e2'
const codexHome = process.env.CODEX_HOME || path.join(require('node:os').homedir(), '.codex')
const rolloutPath = path.join(
  codexHome,
  'sessions',
  ROLLOUT_DAY,
  `rollout-2026-11-24T00-00-00-${threadId}.jsonl`
)
const rolloutExisted = fs.existsSync(rolloutPath)
if (!rolloutExisted) {
  fs.mkdirSync(path.dirname(rolloutPath), { recursive: true })
  fs.writeFileSync(rolloutPath, `${JSON.stringify({ type: 'session_meta', id: threadId })}\n`)
}

const recordPath = process.env.ORCA_E2E_RESTART_RECORD
if (recordPath) {
  fs.appendFileSync(
    recordPath,
    `${JSON.stringify({ pid: process.pid, codexHome: process.env.CODEX_HOME ?? null, argv, threadId, rolloutPath, rolloutExisted, at: Date.now() })}\n`
  )
}

async function reportSessionToOrca() {
  const port = process.env.ORCA_AGENT_HOOK_PORT
  const token = process.env.ORCA_AGENT_HOOK_TOKEN
  if (!port || !token) {
    return
  }
  const payload = JSON.stringify({
    session_id: threadId,
    transcript_path: rolloutPath,
    cwd: process.cwd(),
    hook_event_name: 'SessionStart'
  })
  const body = new URLSearchParams({
    paneKey: process.env.ORCA_PANE_KEY ?? '',
    tabId: process.env.ORCA_TAB_ID ?? '',
    launchToken: process.env.ORCA_AGENT_LAUNCH_TOKEN ?? '',
    worktreeId: process.env.ORCA_WORKTREE_ID ?? '',
    env: process.env.ORCA_AGENT_HOOK_ENV ?? '',
    version: process.env.ORCA_AGENT_HOOK_VERSION ?? '',
    agentProcess: String(process.pid),
    payload
  })
  try {
    await fetch(`http://127.0.0.1:${port}/hook/codex`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Orca-Agent-Hook-Token': token
      },
      body
    })
  } catch {
    // The spec reports a missing session; the stub keeps running.
  }
}

let composer = ''
let lastSubmission = ''
function render() {
  process.stdout.write(
    `\x1b]0;Codex\x07\x1b[H\x1b[2JAccount Restart Stub\r\n[${READY_MARKER}] ${threadId}\r\n> ${composer}${lastSubmission ? `\r\n[${SUBMITTED_MARKER}] ${process.pid} ${lastSubmission}` : ''}`
  )
}

function exit() {
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false)
  }
  process.stdout.write('\x1b[?1049l', () => process.exit(0))
}

if (process.stdin.isTTY) {
  process.stdin.setRawMode(true)
}
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  for (const char of String(chunk)) {
    if (char === '\r' || char === '\n') {
      lastSubmission = composer
      composer = ''
    } else if (char === '\x03' || char === '\x04') {
      exit()
      return
    } else if (char >= ' ') {
      composer += char
    }
  }
  render()
})
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, exit)
}
process.stdout.write('\x1b[?1049h')
render()
void reportSessionToOrca()
