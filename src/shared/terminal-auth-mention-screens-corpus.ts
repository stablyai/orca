// Auth wording that lands on the BOTTOM row with no composer caret under it, which is the one
// place the prompt-shape rules have to make a judgement call. Every screen here was a confirmed
// false positive: the flow phrase sits mid-row (a commit subject, a changelog entry, a checklist,
// an error summary) or the row is narration in a language whose sentences never end in an ASCII
// period. Sibling of AGENT_AUTH_SUMMARY_SCREENS, which covers the composer-caret case.
import type { TerminalCredentialPromptCase } from './terminal-live-credential-surfaces-corpus'

export const AGENT_AUTH_MENTION_SCREENS: readonly TerminalCredentialPromptCase[] = [
  // Records, not requests: the flow phrase is quoted inside a line whose subject is something else.
  [
    'git log ending on a sign-in commit subject',
    [
      '$ git log --oneline -3',
      'a1b2c3d fix(auth): drop the stale authorization header',
      'd4e5f6a feat(auth): sign in with GitHub'
    ]
  ],
  ['single sign-in commit subject', ['d4e5f6a feat(auth): sign in with GitHub']],
  ['changelog entry for a sign-in feature', ['## Unreleased', '- feat(auth): sign in with Apple support']],
  [
    'checklist item for a sign-in button',
    ['Plan:', '  [x] add session cookie', '  [ ] add sign in with Google button']
  ],
  [
    'error summary quoting an auth failure',
    ['• Fixed the deploy step', '• Root cause: authentication required from the vercel CLI']
  ],
  [
    'rg hits ending the screen on a sign-in match',
    [
      '$ rg "sign in with" src/',
      'src/Login.tsx:31:  <button>Sign in with GitHub</button>',
      'src/Login.tsx:44:  // authorization code exchange happens here'
    ]
  ],
  // "waiting for you to …" is how every agent narrates waiting on a human, auth or not.
  [
    'agent waiting on a diff review after login work',
    ['• Updated the login page copy', '⏳ Waiting for you to review the diff']
  ],
  [
    'agent waiting on a branch choice after authorization work',
    ['• Rebased the authorization middleware', 'Waiting for you to choose a base branch']
  ],
  // Localized narration: the wording it embeds is English, the punctuation is not.
  [
    'zh-TW narration of a failed deploy on the bottom row',
    ['$ pnpm deploy', '錯誤：authentication required，請先執行 gh auth login']
  ],
  [
    'zh-TW claude narration ending in a fullwidth stop',
    ['· 已新增 SSO 登入流程', '· 使用者現在可以 sign in with Okta，並支援 MFA。']
  ],
  [
    'japanese narration of device-code work on the bottom row',
    ['✦ OAuth を実装しました', '✦ device code フローで authorization を待機する処理を追加']
  ],
  [
    'german narration of login work on the bottom row',
    [
      '• Anmeldung überarbeitet',
      '• Der Nutzer kann sich jetzt per sign in with Google authentifizieren'
    ]
  ],
  // Agents whose chrome the corpus otherwise never sees.
  [
    'factory droid narrating a sign-in feature',
    [
      '  ⏺ Added sign in with Google to the settings page',
      '',
      '  droid · claude-opus-4 · ~/repo',
      '  ⏎ send  ⇧⏎ newline'
    ]
  ],
  [
    'opencode narrating a token refresh above its status bar',
    [
      'Refreshed the access token and retried the request',
      '',
      '❯ ',
      'opencode  anthropic/claude-opus-4  ~/repo'
    ]
  ],
  [
    'cursor-agent approval menu (captured chrome)',
    [
      ' $  git status --porcelain in .',
      '',
      ' Run this command?',
      ' Not in allowlist: git status',
      '  → Run (once) (y)',
      '    Add Shell(git status) to allowlist? (tab)',
      '    Run Everything (shift+tab)',
      '    Skip & tell the agent what to do instead (esc or n)'
    ]
  ],
  // The sibling dialogs of the Antigravity sign-in menu, same chrome and same bare `>` caret.
  // They are the cost side of catching that menu: a rule that reads a numbered option list as a
  // credential prompt must still refuse these.
  [
    'antigravity model picker',
    [
      'Antigravity CLI 1.0.3',
      'user@example.com (Antigravity Business)',
      'Select a model',
      '~/orca/workspaces/orca/agy-dispatch-issue',
      '1. Claude Sonnet 4.5',
      '2. GPT-5.1',
      '>'
    ]
  ],
  [
    'antigravity privacy notice',
    [
      'Antigravity CLI 1.0.3',
      'We collect usage data to improve the product',
      '1. Accept',
      '2. Decline',
      '>'
    ]
  ],
  [
    'command code idle composer',
    ['# Command Code v0.27.2', ':: done', '❯ Ask your question...']
  ],
  [
    'claude code chinese status frame',
    ['✻ 执行任务中…', '⎿ 正在分析代码库结构与依赖关系，请稍候…']
  ],
  [
    'dotenv example printed by the agent',
    ['$ cat .env.example', 'DATABASE_URL=', 'API_KEY=', 'SESSION_SECRET=']
  ],
  [
    'workflow secrets block printed by the agent',
    [
      '      env:',
      '        GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}',
      '        NPM_TOKEN: ${{ secrets.NPM_TOKEN }}'
    ]
  ]
]
