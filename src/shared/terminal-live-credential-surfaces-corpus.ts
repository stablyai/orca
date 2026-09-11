// Screens a live credential or sign-in surface owns, i.e. every screen the guard MUST refuse.
// Shared by the shared-detector suite, the main-process wait-vocabulary suite and the renderer
// paste-lane suite: one corpus keeps the three lanes provably in agreement.

export type TerminalCredentialPromptCase = readonly [name: string, lines: string[]]

export const LIVE_CREDENTIAL_SURFACES: readonly TerminalCredentialPromptCase[] = [
  [
    'antigravity device-code sign-in drawn over ready chrome (#19749)',
    [
      'Antigravity CLI',
      'gemini 3 pro (high)',
      '~/orca/workspaces/orca/crash-closer',
      '>',
      '',
      '  Sign in to Antigravity',
      '  Open https://antigravity.google/device and enter the code: KXTD-9PQR',
      '  Waiting for authentication…'
    ]
  ],
  [
    'antigravity auth-method menu over ready chrome',
    [
      'Antigravity CLI',
      'gemini 3 pro (high)',
      '>',
      '',
      '? How would you like to authenticate?',
      '❯ Sign in with Google',
      '  Use an API key'
    ]
  ],
  [
    'api-key prompt under a complete Codex ready header',
    [
      'OpenAI Codex',
      'model: gpt-6',
      'directory: ~/repo',
      '',
      '› Ask Codex to do anything',
      '',
      'Enter your API key:'
    ]
  ],
  ['bare api-key ask', ['Enter your API key: ']],
  ['vendor-qualified api-key ask with a caret', ['? Enter your Anthropic API key ›']],
  ['bare password label', ['Password:']],
  ['lowercase password label', ['password: ']],
  ['sudo password', ['[sudo] password for neil:']],
  ['ssh key passphrase', ["Enter passphrase for key '/Users/neil/.ssh/id_ed25519':"]],
  ['git username', ["Username for 'https://github.com': "]],
  ['git password', ["Password for 'https://neil@github.com': "]],
  ['sms verification code', ['Enter the verification code we sent to your phone:']],
  ['one-time code', ['Enter your one-time code:']],
  [
    'two-factor dialog',
    ['Two-factor authentication', 'Enter the 6-digit code from your authenticator app:']
  ],
  ['personal access token paste', ['Paste your personal access token here:']],
  ['sign-in wall', ['Authentication required', 'Sign in with GitHub to continue']],
  [
    'oauth device-code flow',
    [
      'Please open the following url in your browser:',
      '  https://github.com/login/device',
      '',
      'and enter the code: ABCD-1234'
    ]
  ],
  ['client secret', ['Enter client secret:']],
  ['password confirmation', ['Re-enter password:']],
  ['access token ask', ['Provide your access token:']],
  ['otp ask', ['Type your OTP:']],
  ['bare credentials label', ['credentials:']],
  ['device code ask', ['Enter device code:']],
  [
    'gh auth login device code',
    [
      '! First copy your one-time code: 1A2B-3C4D',
      'Press Enter to open github.com in your browser...'
    ]
  ],
  [
    'claude /login paste-code screen',
    [
      "Browser didn't open? Use the url below to sign in:",
      'https://claude.ai/oauth/authorize?code=true',
      'Paste code here if prompted >'
    ]
  ],
  // The dialog this guard was written for (F19749-1). A numbered menu of credential actions
  // ending in a bare `>` caret: no terminator anywhere, so only the row-final noun carries it.
  [
    'antigravity sign-in menu over ready chrome',
    [
      'Antigravity CLI 1.0.3',
      'user@example.com (Antigravity Business)',
      'Sign in to continue',
      '~/orca/workspaces/orca/agy-dispatch-issue',
      '1. Open browser',
      '2. Paste an API key',
      '>'
    ]
  ],
  ['vendor-qualified indented api-key ask', ['  Enter your Antigravity API key:']],
  // A bracketed confirm default is a mainstream prompt convention (apt, readline, enquirer), so
  // `[` and `]` must not read as code. `(y/N)` works too; both shapes are live prompts.
  ['bracketed confirm default', ['? Authenticate with the CLI? [Y/n]']],
  ['bracketed sign-in confirm', ['? Sign in with GitHub? [y/N]']],
  // sudo translates its prompt but never its `[sudo]` tag, and the only thing it asks for is a
  // password. An English-only rule here misses every non-English desktop.
  ['sudo password on a German system', ['[sudo] Passwort für neil:']],
  ['sudo password on a zh-TW system', ['[sudo] neil 的密碼：']],
  ['sudo password on a Japanese system', ['[sudo] neil のパスワード:']],
  ['sudo retry notice', ['[sudo] Sorry, try again.', '[sudo] password for neil:']],
  // The common api-key ask names the env var it fills, so the noun carries an underscore.
  [
    'aider env-var api-key ask',
    ['Aider v0.86.1', 'Model: gpt-6 with diff edit format', '', 'Enter your OPENAI_API_KEY:']
  ],
  ['bare env-var api-key label', ['ANTHROPIC_API_KEY:']],
  ['waiting on the user to sign in', ['Waiting for you to sign in…']],
  [
    'crush api-key onboarding dialog',
    [
      '╭─ Crush ───────────────────────╮',
      '│  Connect your model provider           │',
      '│  Paste your API key here:              │',
      '╰─────────────────────────────╯'
    ]
  ]
]
