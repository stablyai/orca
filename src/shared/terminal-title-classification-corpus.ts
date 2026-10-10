/**
 * Realistic terminal-title corpus for pinning agent classification.
 *
 * Why a shared const: the corpus is the contract the memoized classifiers must
 * reproduce byte-for-byte, so the pinning test and the memo regression test
 * read the same titles.
 */
export const TERMINAL_TITLE_CLASSIFICATION_CORPUS: readonly string[] = [
  // Plain shell / directory titles — must classify as nothing.
  '',
  'zsh',
  'bash',
  'nwparker@mac: ~/orca',
  'npm run dev',
  // Boundary-guard cases from agent-name-token-match.ts's header comment.
  'opencode-blinker',
  'openclaude',
  'openclaude-scratch',
  'claude-scratch',
  '~/codex/ready',
  'review-14600-codex',
  'timestamp ready',
  'android build running',
  '~/hermes/working',
  'C:\\tools\\codex\\run',
  '/usr/local/bin/claude/notes',
  'agy-nightly',
  // Windows launcher suffixes.
  'codex.exe',
  'openclaude.cmd',
  'claude.bat working',
  'aider.ps1 ready',
  'copilot.exe - action required',
  'droid.exe',
  // Claude Code prefixes and identity frames.
  '\u2733',
  '\u2733 Claude Code',
  '\u2733 ready',
  '. building the parser',
  '* done',
  'Claude Code',
  'claude - action required',
  'Claude ready',
  'claude agents',
  '"/usr/local/bin/claude" agents',
  // Leading spinner glyphs (braille + quarter circle).
  '\u280b Claude Code',
  '\u2809 Codex \u2014 refactoring',
  '\u25d0 working',
  '\u25d3 Grok',
  '\u280b Cursor Agent',
  '\u280b Droid',
  '\u280b Hermes',
  // Gemini glyph vocabulary.
  '\u2726 gemini',
  '\u23f2 Gemini CLI',
  '\u25c7 Gemini CLI',
  '\u270b Gemini CLI',
  'gemini',
  'antigravity gemini 3 pro',
  'agy - gemini 2 flash',
  // Named agents with status words.
  'codex working',
  'codex ready',
  'copilot waiting',
  'devin thinking',
  'mimo idle',
  'aider running',
  'grok done',
  'opencode ready',
  'hermes ready',
  'droid ready',
  // Cursor's closed identity set.
  'cursor agent',
  'cursor ready',
  'cursor - action required',
  'cursor position reset',
  // Pi / OMP compatible titles.
  '\u03c0 > session - ~/orca',
  '\u03c0 ! blocked-session',
  '\u280b \u03c0 - session - ~/orca',
  // Wrapper/multiplexer prefixes.
  'zsh | \u280b Codex',
  'tmux | claude - action required',
  'ssh host | opencode ready'
]
