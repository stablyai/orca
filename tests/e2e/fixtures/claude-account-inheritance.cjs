const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { spawnSync } = require('node:child_process')
const args = process.argv.slice(2)
if (args.includes('--version')) {
  console.log('2.1.317 (Claude Code)')
  process.exit(0)
}
const env = process.env
const configDir = env.CLAUDE_CONFIG_DIR || null
const identityFile = configDir ? path.join(configDir, '.claude.json') : null
const account =
  identityFile && fs.existsSync(identityFile)
    ? (JSON.parse(fs.readFileSync(identityFile, 'utf8')).oauthAccount?.accountUuid ?? null)
    : null
if (process.stdin.isTTY || args.includes('--session-id')) {
  fs.appendFileSync(
    env.ORCA_E2E_ACCOUNT_LEDGER,
    `${JSON.stringify({
      account,
      configDir,
      ptyId: env.ORCA_PTY_ID,
      terminalHandle: env.ORCA_TERMINAL_HANDLE,
      paneKey: env.ORCA_PANE_KEY
    })}\n`
  )
}
if (args.includes('--input-format')) {
  const stub = path.join(__dirname, 'structured-claude-stub.cjs')
  process.argv = [process.execPath, stub, env.ORCA_E2E_ACCOUNT_STREAM_LOG, ...args]
  require(stub)
  return
}
if (!process.stdin.isTTY) {
  process.exit(0)
}
process.title = 'claude'
const endpoint = JSON.parse(env.ORCA_E2E_ACCOUNT_HOOK)
const sessionId = randomUUID()
async function hook(name, extra = {}) {
  await fetch(`http://127.0.0.1:${endpoint.port}/hook/claude`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-orca-agent-hook-token': endpoint.token },
    body: JSON.stringify({
      paneKey: env.ORCA_PANE_KEY,
      worktreeId: env.ORCA_WORKTREE_ID,
      tabId: env.ORCA_PANE_KEY.split(':')[0],
      env: endpoint.env,
      version: endpoint.version,
      payload: { session_id: sessionId, cwd: process.cwd(), hook_event_name: name, ...extra }
    })
  })
}
let pending = ''
process.stdin.setRawMode(true)
process.stdin.on('data', async (data) => {
  pending += data.toString()
  if (pending.includes('ORCA_ACCOUNT_EXIT\r')) {
    process.exit(0)
  }
  const command = /ORCA_ACCOUNT_CLI:([A-Za-z0-9+/=]+)\r/.exec(pending)
  if (command) {
    pending = ''
    const request = JSON.parse(Buffer.from(command[1], 'base64').toString())
    const result = spawnSync(
      process.execPath,
      [env.ORCA_E2E_ACCOUNT_CLI, ...request.args, '--json'],
      {
        env: {
          ...env,
          ...request.env,
          ORCA_USER_DATA_PATH: env.ORCA_E2E_ACCOUNT_DATA,
          ORCA_DEV_CLI_INVOCATION: '1'
        },
        encoding: 'utf8',
        timeout: 90_000,
        windowsHide: true
      }
    )
    fs.writeFileSync(
      request.output,
      JSON.stringify({ code: result.status, stdout: result.stdout, stderr: result.stderr })
    )
    return
  }
  // oxlint-disable-next-line no-control-regex -- Matches the PTY's bracketed-paste boundary.
  const prompt = /\x1b\[200~([\s\S]*?)\x1b\[201~\r/.exec(pending)
  if (prompt) {
    pending = ''
    await hook('UserPromptSubmit', { prompt: prompt[1] })
    process.stdout.write('\x1b]7501;state=working:app=claude-code\x1b\\\r\nWorking\r\n')
    await hook('Stop', { last_assistant_message: 'Review complete' })
    process.stdout.write('\x1b]7501;state=idle:app=claude-code\x1b\\\r\nReady\r\n')
  }
})
process.stdin.resume()
hook('SessionStart', { source: 'startup' }).then(() => {
  process.stdout.write(
    `\x1b[?2004h\x1b[?2031hClaude Code account ${account ?? 'system'}\r\n❯\u00a0`
  )
})
