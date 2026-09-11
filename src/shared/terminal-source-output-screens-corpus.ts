// Plain source code printed into the pane — the category the corpus lacked. It had `rg` hits and
// diffs, which carry their own chrome (`└`, `+`), but not bare formatted source, and that is what
// leaked: every line here was mined from this repo's own tracked files and refused a prompt when
// placed one row above a real agent composer caret.
//
// The dominant shape is an oxfmt ternary continuation. `AUTH_QUESTION_ROW_RE` was written on the
// premise that "prose never starts with a bare `?`" — true, and irrelevant, because FORMATTED CODE
// does, in 5,666 tracked files. The rest are `.login` property accesses reading as the auth verb
// `log in`, and one wrapped comment that merely ends on a credential noun.
import type { TerminalCredentialPromptCase } from './terminal-live-credential-surfaces-corpus'

const CODEX = '› Ask Codex to do anything'
const CLAUDE = '> '
const OPENCODE = '❯ '

/** One mined source row above the composer caret that was on screen under it. */
function sourceRow(name: string, line: string, caret: string): TerminalCredentialPromptCase {
  return [name, [line, caret]]
}

export const AGENT_SOURCE_OUTPUT_SCREENS: readonly TerminalCredentialPromptCase[] = [
  // Ternary continuations whose consequent contains auth wording.
  sourceRow(
    'ternary consequent with a sign-in string',
    "      ? 'Update desktop Orca and sign in to connect from anywhere'",
    CODEX
  ),
  sourceRow(
    'ternary consequent with an authentication template literal',
    '        ? `replacement session authentication timed out (${stage})`',
    CLAUDE
  ),
  sourceRow(
    'ternary consequent with a login error',
    '              ? `Codex login failed: ${trimmedOutput}`',
    OPENCODE
  ),
  sourceRow(
    'ternary consequent calling a login spawn builder',
    "      ? buildWindowsHostInteractiveLoginSpawn(codexCommand, ['login'])",
    CODEX
  ),
  sourceRow(
    'ternary consequent with a sign-in status string',
    "        ? 'Timed out while checking Codex sign-in status'",
    CLAUDE
  ),
  sourceRow(
    'ternary consequent reading an authorization basis',
    '        ? this.originPool.controlForBasis(authorization.basisConnId)',
    OPENCODE
  ),
  sourceRow(
    'ternary consequent building a gh auth command',
    '    ? `gh auth login --hostname ${host}`',
    CODEX
  ),
  sourceRow(
    'ternary consequent mentioning a keyring login',
    "      ? ' Your keyring already has a `gh` login that will take over once the env var is gone.'",
    CLAUDE
  ),
  sourceRow(
    'ternary consequent with a translated sign-in-again label',
    "                ? translate('auto.components.settings.artifacts.signInAgain', 'Sign in again')",
    OPENCODE
  ),
  sourceRow(
    'ternary consequent with a personal-access-token docs url',
    "        ? 'https://learn.microsoft.com/azure/devops/accounts/use-pat-to-authenticate'",
    CODEX
  ),
  sourceRow(
    'ternary consequent with a sign-in screen assertion message',
    "    ? 'Codex stopped on the sign-in screen — CODEX_HOME auth was not visible to the TUI'",
    CLAUDE
  ),
  // `.login` property accesses, which `\b` alone reads as the auth verb "log in".
  sourceRow(
    'ternary filtering assignees by login',
    '    ? prevAssignees.filter((l) => l !== login)',
    CODEX
  ),
  sourceRow(
    'ternary narrowing a login to a string',
    "            ? overrides.filter((login): login is string => typeof login === 'string')",
    CLAUDE
  ),
  sourceRow(
    'ternary removing assignees by login',
    '                          ? { removeAssignees: [user.login] }',
    OPENCODE
  ),
  sourceRow(
    'ternary mapping project assignees',
    '                  ? projectRowDetail.assignees.map((login) => ({',
    CODEX
  ),
  sourceRow(
    'ternary removing a reviewer by login',
    '      ? handleRemoveReviewers([reviewer.login])',
    CLAUDE
  ),
  sourceRow(
    'ternary editing assignees by login',
    '                      ? onEditAssignees?.([], [user.login])',
    OPENCODE
  ),
  sourceRow(
    'ternary lowercasing an assignee login',
    '        ? prevAssignees.filter((user) => user.login.toLowerCase() !== lowerLogin)',
    CODEX
  ),
  sourceRow(
    'ternary building a login patch object',
    '              ? { login: candidate.login, name: candidate.name }',
    CLAUDE
  ),
  sourceRow(
    'ternary building an assignee removal patch',
    "        ? { family: 'assignees', kind: 'remove', logins: [login] }",
    OPENCODE
  ),
  sourceRow(
    'ternary filtering selected assignees by login key',
    '          ? selectedAssignees.filter((current) => current.login.toLowerCase() !== key)',
    CODEX
  ),
  // No composer caret, and the bottom row DOES lead with an action phrase — so the only thing
  // keeping this from reading as a live prompt is that `candidate.login` is a property access
  // rather than the auth verb "log in". Pins the lookbehind on its own.
  [
    'source rows where a .login access is the only would-be auth verb',
    [
      '    const owner = candidate.login',
      '    // Enter the code below to finish linking the account'
    ]
  ],
  // A comment marker is not dialog decoration. Row 1 supplies the auth verb, so without that
  // distinction the comment on the bottom row reads as a dialog leading its own row.
  [
    'source comment leading with an action phrase, corroborated by the comment above it',
    [
      '    // See the authentication guide for details',
      '    // Sign in with the provider console to continue'
    ]
  ],
  // Prose that merely ENDS on a credential noun, which an unanchored ask verb read as a prompt.
  sourceRow(
    'wrapped comment ending on a credential noun',
    '    // Why: a merely missing or expired bundle must not enter the credential',
    OPENCODE
  ),
  sourceRow(
    'wrapped comment ending on a password noun',
    '    // The caller must provide the current password',
    CODEX
  ),
  sourceRow(
    'wrapped jsdoc ending on an api key noun',
    '   * Callers are expected to paste their API key',
    CLAUDE
  )
]
