// Agent output ABOUT auth work, which reads exactly like a credential dialog to any rule that
// only looks for auth wording. Every one of these blocked before the pair rule gained a prompt-shape
// requirement, and every one leaves the agent's own composer caret on the last row.
import type { TerminalCredentialPromptCase } from './terminal-live-credential-surfaces-corpus'

export const AGENT_AUTH_SUMMARY_SCREENS: readonly TerminalCredentialPromptCase[] = [
  // An agent SUMMARISING auth work it just finished, with its own composer on the last row.
  // These pair an auth verb with an auth-flow phrase, which is the shape that used to match
  // with no prompt terminator and no position requirement at all.
  [
    'codex summarising two-factor work',
    [
      '• I implemented two-factor authentication for the login flow.',
      '  The authenticator app now generates a 6-digit code.',
      '› Ask Codex to do anything'
    ]
  ],
  [
    'claude summarising two-factor work',
    [
      '· Added two-factor authentication. Tests for the authenticator app pass.',
      '✳ Claude Code',
      '> '
    ]
  ],
  [
    'codex summarising a sign-in button',
    [
      '• Added a Sign in with Google button; it logs the authorization result.',
      '› Ask Codex to do anything'
    ]
  ],
  [
    'codex reporting an auth error it hit',
    [
      '  └ ERROR: authentication required. Please sign in with the CLI.',
      '› Ask Codex to do anything'
    ]
  ],
  [
    'agent asking whether MFA is wanted',
    ['· Should the app require MFA, or is authentication via password enough?', '> ']
  ],
  [
    'codex summarising a device-code flow it built',
    [
      '• The OAuth flow now shows a device code and waits for authentication.',
      '› Ask Codex to do anything'
    ]
  ],
  [
    'rg hit on auth documentation',
    ['  └ docs/auth.md:12: Users authenticate with the authenticator app.', '> ']
  ],
  [
    'rg hits on a login component',
    [
      '  └ src/Login.tsx:31:  <button>Sign in with GitHub</button>',
      '  └ src/Login.tsx:44:  // authorization code exchange',
      '› Ask Codex to do anything'
    ]
  ],
  [
    'codex reporting MFA tests passing',
    ['• All MFA tests pass; authentication is wired end to end.', '› Ask Codex to do anything']
  ],
  [
    'codex quoting a build failure',
    [
      "• The build failed: 'authorization required'. You need to log in with `vercel login`.",
      '› Ask Codex to do anything'
    ]
  ],
  [
    'rg hit on a readme auth section',
    [
      '  └ docs/auth.md:3: ## Authentication',
      '    Users sign in with GitHub or an authenticator app.',
      '> '
    ]
  ],
  [
    'claude summarising an oauth change',
    [
      '· Done — the OAuth login now requires authentication via the device code flow.',
      '✳ Claude Code',
      '> '
    ]
  ],
  [
    'gemini summarising SSO work',
    ['✦ Added SSO. Users authenticate with Okta; the sign in with SAML path is tested.', '◇ ']
  ],
  [
    'opencode wrapping an auth summary',
    [
      'Added requireAuth middleware. Unauthenticated requests get 401; sign in with the',
      'token endpoint returns a JWT.',
      '❯ '
    ]
  ],
  [
    'stack trace over a codex composer',
    [
      'Error: authentication required',
      '    at signInWithToken (auth.ts:22)',
      '› Ask Codex to do anything'
    ]
  ],
  [
    'shell deploy failure',
    [
      'Running deploy...',
      'ERROR: authentication required',
      'Please sign in with the CLI and retry.',
      'exit code 1'
    ]
  ],
  // Printed config whose bare `password:` label is not the screen's bottom row.
  [
    'printed kubernetes secret manifest',
    ['kind: Secret', 'stringData:', '      password:', '› Ask Codex to do anything']
  ],
  [
    'printed signup form template',
    [
      '• The signup form now has these fields:',
      '  email:',
      '  password:',
      '› Ask Codex to do anything'
    ]
  ]
]
