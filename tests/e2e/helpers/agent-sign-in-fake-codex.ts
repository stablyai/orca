// A scripted `codex` whose browser login answers on a localhost callback, like `codex login`.
import { chmodSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const FAKE_CODEX_SOURCE = `#!/usr/bin/env node
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const os = require('node:os')
const args = process.argv.slice(2)
const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
const authFile = path.join(home, 'auth.json')
const email = process.env.FAKE_CLAUDE_EMAIL || 'demo@example.com'
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
const signIn = () => {
  const claims = { email, 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-demo', chatgpt_plan_type: 'pro' } }
  const idToken = b64({ alg: 'none' }) + '.' + b64(claims) + '.sig'
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(authFile, JSON.stringify({
    tokens: { id_token: idToken, access_token: 'a', refresh_token: 'r', account_id: 'acct-demo' },
    last_refresh: new Date().toISOString()
  }))
}
if (args[0] === '--version') {
  console.log('codex-cli 0.167.0')
  process.exit(0)
}
if (args[0] === 'login' && args[1] === 'status') {
  const loggedIn = fs.existsSync(authFile)
  console.error(loggedIn ? 'Logged in using ChatGPT' : 'Not logged in')
  process.exit(loggedIn ? 0 : 1)
}
if (args[0] === 'logout') {
  fs.rmSync(authFile, { force: true })
  process.exit(0)
}
if (args[0] === 'login') {
  const port = Number(process.env.FAKE_CODEX_CALLBACK_PORT || 1455)
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')
    if (url.pathname === '/auth/callback' && url.searchParams.get('code')) {
      signIn()
      res.writeHead(302, { Location: 'http://localhost:' + port + '/success' })
      res.end()
      setTimeout(() => {
        console.error('Successfully logged in')
        process.exit(0)
      }, 100)
      return
    }
    res.writeHead(404)
    res.end()
  })
  // Why [::1]: the paired client on the same machine owns 127.0.0.1 for the forwarded callback.
  server.listen(port, '::1', () => {
    const redirect = encodeURIComponent('http://localhost:' + port + '/auth/callback')
    const url = 'https://auth.openai.com/oauth/authorize?response_type=code&client_id=fake&redirect_uri=' + redirect + '&state=fake'
    console.error('If your browser did not open, navigate to this URL to authenticate:\\n\\n' + url + '\\n')
  })
  return
}
const prompt = args.filter((arg) => !arg.startsWith('-')).join(' ')
process.stdout.write('>_ OpenAI Codex (fake) · ' + (fs.existsSync(authFile) ? email : 'not signed in') + '\\r\\n')
if (prompt) {
  process.stdout.write('› ' + prompt + '\\r\\n')
}
process.stdin.resume()
`

/** Adds the fake `codex` beside the fake `claude` in `dir`. */
export function writeAgentSignInFakeCodex(dir: string): void {
  const file = path.join(dir, 'codex')
  writeFileSync(file, FAKE_CODEX_SOURCE)
  chmodSync(file, 0o755)
}
