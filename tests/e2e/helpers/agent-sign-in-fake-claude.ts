// A scripted `claude` whose browser sign-in answers on a localhost callback, like the real CLI.
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const FAKE_CLAUDE_SOURCE = `#!/usr/bin/env node
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const os = require('node:os')
const { spawn } = require('node:child_process')
const args = process.argv.slice(2)
const stateFile = path.join(process.env.CLAUDE_CONFIG_DIR || os.homedir(), '.claude.json')
const email = process.env.FAKE_CLAUDE_EMAIL || 'demo@example.com'
const loggedIn = () => {
  try { return Boolean(JSON.parse(fs.readFileSync(stateFile, 'utf8')).oauthAccount) } catch { return false }
}
const signIn = () => {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true })
  fs.writeFileSync(stateFile, JSON.stringify({ oauthAccount: { emailAddress: email } }))
}
if (args[0] === '--version') {
  console.log('2.1.319 (Claude Code)')
  process.exit(0)
}
if (args[0] === 'auth' && args[1] === 'status') {
  console.log(JSON.stringify({ loggedIn: loggedIn(), authMethod: loggedIn() ? 'claude.ai' : 'none' }))
  process.exit(loggedIn() ? 0 : 1)
}
if (args[0] === 'auth' && args[1] === 'logout') {
  fs.rmSync(stateFile, { force: true })
  process.exit(0)
}
if (args[0] === 'auth' && args[1] === 'login') {
  const port = Number(process.env.FAKE_CLAUDE_CALLBACK_PORT || 54545)
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')
    if (url.pathname === '/callback' && url.searchParams.get('code')) {
      signIn()
      res.writeHead(302, { Location: 'https://claude.ai/oauth/code/success?app=claude-code' })
      res.end()
      setTimeout(() => {
        console.log('Login successful.')
        process.exit(0)
      }, 100)
      return
    }
    res.writeHead(404)
    res.end()
  })
  // Why [::1]: the paired client on the same machine owns 127.0.0.1 for the forwarded callback.
  server.listen(port, process.env.FAKE_CLAUDE_CALLBACK_HOST || '::1', () => {
    const redirect = encodeURIComponent('http://localhost:' + port + '/callback')
    const browserLink = 'https://claude.ai/oauth/authorize?client_id=fake&response_type=code&redirect_uri=' + redirect + '&state=fake'
    const pasteLink = 'https://claude.ai/oauth/authorize?code=true&client_id=fake&response_type=code&redirect_uri=' + encodeURIComponent('https://platform.claude.com/oauth/code/callback') + '&state=fake'
    if (process.env.BROWSER) {
      spawn(process.env.BROWSER, [browserLink], { stdio: 'ignore' })
    }
    process.stdout.write("Browser didn't open? Use the url below to sign in\\n\\n" + pasteLink + '\\n\\nPaste code here if prompted > ')
  })
  process.stdin.on('data', (chunk) => {
    if (chunk.toString().trim()) {
      signIn()
      console.log('Login successful.')
      process.exit(0)
    }
  })
  return
}
// An interactive session: echo the prompt like Claude's first turn.
const prompt = args.filter((arg, index) => !arg.startsWith('-') && args[index - 1] !== '--plugin-dir').join(' ')
process.stdout.write('\\x1b[38;5;173m✻ Claude Code\\x1b[0m · ' + process.cwd() + ' · ' + (loggedIn() ? email : 'not signed in') + '\\r\\n\\r\\n')
if (prompt) {
  process.stdout.write('> ' + prompt + '\\r\\n\\r\\n\\x1b[38;5;173m⏺\\x1b[0m Working on it…\\r\\n')
}
process.stdin.resume()
`

/** Writes the fake `claude` into a fresh directory to put first on the host's PATH. */
export function writeAgentSignInFakeClaude(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'orca-fake-claude-'))
  const file = path.join(dir, 'claude')
  writeFileSync(file, FAKE_CLAUDE_SOURCE)
  chmodSync(file, 0o755)
  return dir
}
