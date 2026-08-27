import { describe, expect, it } from 'vitest'
import { AGENT_STALL_SIGNATURE_MAX_CHARS, classifyAgentStallLine } from './agent-stall-signature'

describe('classifyAgentStallLine', () => {
  it('classifies the auth failures the CLIs actually print', () => {
    const authLines = [
      'API Error: 401 {"type":"error","error":{"type":"authentication_error"}}',
      'Invalid API key · Please run /login',
      'Your OAuth token has expired. Please run /login again.',
      "You're not logged in. Run `codex login` to continue.",
      'Error: credentials expired, please reauthenticate',
      'Login required',
      'error: invalid_grant'
    ]

    for (const line of authLines) {
      expect(classifyAgentStallLine(line)?.cause, line).toBe('auth')
    }
  })

  it('classifies the network failures the CLIs actually print', () => {
    const networkLines = [
      'API Error: Connection error.',
      // Verbatim from Claude Code 2.1.247 with its API endpoint unreachable.
      'API Error: Connection refused \u2014 a firewall or proxy may be blocking it (ConnectionRefused)',
      'TypeError: fetch failed',
      'Error: socket hang up',
      'read ECONNRESET',
      'connect ETIMEDOUT 160.79.104.10:443',
      'getaddrinfo EAI_AGAIN api.anthropic.com',
      'API Error: 503 Service Unavailable',
      '{"type":"overloaded_error"}',
      'Error: request to https://api.example.com failed, reason: connection refused'
    ]

    for (const line of networkLines) {
      expect(classifyAgentStallLine(line)?.cause, line).toBe('network')
    }
  })

  it('refuses failures a restart cannot fix', () => {
    // A spent balance reopens on payment, not on a clock — unlike a rate limit,
    // which is its own cause below.
    const unrecoverable = [
      'Your credit balance is too low to access the Anthropic API.',
      'Error: invalid model claude-nope-5',
      'Error: prompt is too long: 250000 tokens > 200000 maximum',
      'EACCES: permission denied, open /etc/hosts'
    ]

    for (const line of unrecoverable) {
      expect(classifyAgentStallLine(line), line).toBeNull()
    }
  })

  it('reads a spent usage window as its own recoverable cause', () => {
    // Observed live: these are what a session-limited pane actually prints, and
    // every one of them used to classify as nothing at all.
    const rateLimited = [
      "You've hit your session limit \u00b7 resets 3:10pm (Asia/Jerusalem)",
      'Usage limit reached. Your limit will reset at 3pm.',
      'Usage limit reached \u00b7 continuing automatically at 3:10pm',
      'API Error: 429 rate_limit_error \u2014 retry after 60s',
      'Error: quota exceeded for this account'
    ]

    for (const line of rateLimited) {
      expect(classifyAgentStallLine(line)?.cause, line).toBe('rate-limit')
    }
  })

  it('reads a swapped account as a sign-in failure', () => {
    const line =
      'Remote Control disconnected \u2014 signed-in claude.ai account or organization changed on this machine \u2014 run /remote-control to start a session for the current account, or /login to switch back'

    expect(classifyAgentStallLine(line)?.cause).toBe('auth')
  })

  it('does not read an agent working on error-handling code as a stalled agent', () => {
    const prose = [
      "I'll add a timeout to the network client so connection errors retry.",
      'Next I need to authenticate the request before sending it.',
      '+  throw new Error("connection refused")',
      '-      console.error("fetch failed", err)',
      '> Error: connection error',
      '  42: if (err.code === "ECONNRESET") {',
      '@@ -10,7 +10,7 @@ function connect() {',
      'echo "network error" >> log.txt'
    ]

    for (const line of prose) {
      expect(classifyAgentStallLine(line), line).toBeNull()
    }
  })

  it('requires a failure marker before generic connectivity wording counts', () => {
    expect(classifyAgentStallLine('Connecting to the runtime…')).toBeNull()
    expect(classifyAgentStallLine('Reconnecting; network unreachable, retrying')?.cause).toBe(
      'network'
    )
  })

  it('bounds the signature it hands the UI', () => {
    const long = `unable to reach the network: ${'x'.repeat(500)}`

    const signature = classifyAgentStallLine(long)?.signature ?? ''

    expect(signature.length).toBeLessThanOrEqual(AGENT_STALL_SIGNATURE_MAX_CHARS)
  })

  it('ignores empty and pathologically long lines', () => {
    expect(classifyAgentStallLine('')).toBeNull()
    expect(classifyAgentStallLine(`ECONNRESET${' '.repeat(5000)}`)).toBeNull()
  })
})
