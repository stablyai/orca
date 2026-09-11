// The other side of the credential-prompt corpus: screens the guard MUST let through. A refusal
// here is worse than a missed prompt — the reason is unconditional, so it also pins an idle agent
// to `permission` in the agent-status store.
import type { TerminalCredentialPromptCase } from './terminal-live-credential-surfaces-corpus'
import { AGENT_AUTH_SUMMARY_SCREENS } from './terminal-agent-auth-summary-screens-corpus'
import { AGENT_AUTH_MENTION_SCREENS } from './terminal-auth-mention-screens-corpus'

export const LEGITIMATE_AGENT_SCREENS: readonly TerminalCredentialPromptCase[] = [
  // An agent narrating credential work and returning to its composer.
  [
    'codex narrating password hashing',
    [
      '• I added bcrypt password hashing to src/auth/user.ts.',
      '',
      '› Ask Codex to do anything',
      '',
      '  gpt-6 medium · ~/repo'
    ]
  ],
  [
    'codex narrating api-key wiring',
    ['• Wired the API key into .env.example and documented it.', '', '› Ask Codex to do anything']
  ],
  [
    'claude narrating login work',
    ['· Updated the login form to use the new session cookie.', '', '✳ Claude Code', '', '> ']
  ],
  [
    'codex narrating an oauth refresh',
    [
      '• Done. The OAuth device-code flow now refreshes the access token.',
      '',
      '› Ask Codex to do anything'
    ]
  ],
  [
    'claude narrating a secret rotation',
    ['· I rotated the client secret and pushed the change.', '', '> ']
  ],
  // An agent legitimately ASKING the user something credential-adjacent.
  [
    'agent asks where to store a password',
    [
      '· Should I store the password in the .env file or in the keychain?',
      '',
      '✳ Claude Code',
      '',
      '> '
    ]
  ],
  [
    'agent asks about reading an api key',
    ['· Do you want me to read your api key from process.env.OPENAI_API_KEY?', '', '> ']
  ],
  [
    'agent asks which auth provider',
    ['· Which auth provider should the sign in page use?', '', '> ']
  ],
  [
    'agent asks about a token in CI',
    ['· I need to know: does your CI already have a personal access token?', '', '> ']
  ],
  [
    'agent asks where a template goes',
    ['· Where should I put the verification code template?', '', '> ']
  ],
  ['agent asks about OTP expiry', ['· Should the OTP expire after 5 minutes or 10?', '', '> ']],
  [
    'agent asks about 2FA delivery',
    ['· Do you want 2FA codes emailed or via authenticator app?', '', '> ']
  ],
  [
    'agent narrates an upcoming passphrase edit',
    ['· Ready. Next I will enter the passphrase handling into the key loader.', '', '> ']
  ],
  [
    'agent narrates an api-key edit mid-sentence',
    ['· I will enter the API key into the vault once you confirm the vault name', '', '> ']
  ],
  [
    'agent asks which secret key to rotate',
    ['· Please tell me which secret key you want rotated first', '', '> ']
  ],
  // The user's own task prompt echoed above the composer.
  ['echoed login task prompt', ['> Implement the login form', '', '· Working…']],
  [
    'echoed password-reset task prompt',
    ['> add password reset via one-time code', '', '· Working…']
  ],
  [
    'echoed credentials task prompt',
    ['> Refactor the credentials module', '', '✳ Claude Code', '', '> ']
  ],
  // Search output quoting credential-shaped source, the shape that broke earlier detectors.
  [
    'rg hit on a password call',
    [
      '  └ src/auth.ts:42:  const password = await promptPassword()',
      '',
      '› Ask Codex to do anything'
    ]
  ],
  [
    'rg hit on an api-key label literal',
    ["  └ 118:    label: 'Enter your API key'", '', '› Ask Codex to do anything']
  ],
  [
    'rg hit on a password test name',
    ["  └ tests/auth.test.ts:9:  it('prompts for password', () => {", '', '> ']
  ],
  [
    'search narration quoting a prompt',
    ['  └ Search "enter your password" in src/', '', '› Ask Codex to do anything']
  ],
  // A diff that ADDS a credential prompt string.
  [
    'diff adding an api-key log',
    ['+  console.log("Enter your API key:")', '', '› Ask Codex to do anything']
  ],
  ['diff adding a password prompt field', ['+    prompt: "Password:"', '', '> ']],
  // Other terminal traffic.
  [
    'cursor approval menu',
    [
      'Run this command?',
      '  cat ~/.ssh/id_rsa',
      '  Run (once) (enter)',
      '  Skip & tell the agent (esc)'
    ]
  ],
  [
    'vitest auth suite output',
    [
      '  ✓ auth > rejects an expired access token (4 ms)',
      '  ✓ auth > hashes the password with argon2 (9 ms)',
      '',
      'Test Files  1 passed'
    ]
  ],
  [
    'jest login suite output',
    ['PASS src/login.test.ts', '', '  ● login form › submits credentials', '', '> ']
  ],
  [
    'git push rejection',
    [
      'remote: Support for password authentication was removed.',
      'fatal: Authentication failed',
      '$ '
    ]
  ],
  ['clean git push', ['Everything up-to-date', '$ ']],
  [
    'rendered readme auth section',
    ['## Authentication', '', 'Set `ORCA_API_KEY` in your environment before running.', '', '$ ']
  ],
  [
    'agent narrating a failed gh auth',
    [
      '• The gh CLI says authentication failed; I skipped the PR step.',
      '',
      '› Ask Codex to do anything'
    ]
  ],
  ...AGENT_AUTH_SUMMARY_SCREENS,
  ...AGENT_AUTH_MENTION_SCREENS
]
