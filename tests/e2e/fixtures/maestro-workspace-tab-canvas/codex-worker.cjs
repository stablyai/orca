#!/usr/bin/env node
if (process.argv.slice(2).includes('app-server')) {
  process.stderr.write("error: unrecognized subcommand 'app-server'\n")
  process.exit(2)
}
const write = (text) => process.stdout.write(text)
write('\u001b]0;Codex MWC worker\u0007')
// Ready header the tui-idle probe recognizes: "OpenAI Codex" + model + directory.
write('OpenAI Codex\n')
write(`model: gpt-5.6-sol\ndirectory: ${process.cwd()}\n`)
// Codex enables bracketed paste before mounting its composer; the composer glyph
// after DECSET 2004 is the readiness marker the draft-paste scanner waits for.
write('\u001b[?2004h')
write('\u203a \n')
write('MWC_WORKER_REAL_PTY_READY\n')

function postHook(payload) {
  const port = process.env.ORCA_AGENT_HOOK_PORT
  const token = process.env.ORCA_AGENT_HOOK_TOKEN
  const paneKey = process.env.ORCA_PANE_KEY
  if (!port || !token || !paneKey) {
    return
  }
  const body = JSON.stringify({
    paneKey,
    tabId: paneKey.includes(':') ? paneKey.split(':')[0] : undefined,
    worktreeId: process.env.ORCA_WORKTREE_ID,
    launchToken: process.env.ORCA_AGENT_LAUNCH_TOKEN,
    env: 'production',
    payload
  })
  fetch(`http://127.0.0.1:${port}/hook/codex`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Orca-Agent-Hook-Token': token },
    body
  }).catch(() => {})
}

// Settle the pane to idle after startup: the dispatched prompt must be a real
// idle -> working transition after the app captures its prompt baseline.
setTimeout(() => {
  postHook({ hook_event_name: 'SessionStart', model: 'gpt-5.6-sol' })
  setTimeout(() => postHook({ hook_event_name: 'Stop', model: 'gpt-5.6-sol' }), 250)
}, 300)

let scheduled = false
function reportTurn() {
  // The working hook must land after the app's render-gate baseline, or it pings
  // an already-working state and the turn start stays unobserved.
  postHook({
    hook_event_name: 'UserPromptSubmit',
    prompt: 'MWC worker dispatch',
    model: 'gpt-5.6-sol'
  })
  setTimeout(() => {
    postHook({
      hook_event_name: 'PreToolUse',
      model: 'gpt-5.6-sol',
      tool_name: 'exec_command',
      tool_input: { cmd: 'echo MWC worker dispatch' }
    })
  }, 250)
}

process.stdin.on('data', (chunk) => {
  if (chunk.toString().includes('\r')) {
    process.stdout.write('MWC_WORKER_ACK\n')
  }
  if (!scheduled) {
    scheduled = true
    setTimeout(reportTurn, 12000)
  }
})
process.stdin.resume()
setInterval(() => {}, 60_000)
