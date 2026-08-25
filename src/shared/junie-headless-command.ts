import { optionName } from './print-mode-headless-command'

// Why: `junie "text"` (positional) and `junie --task "text"` run one batch task and exit;
// `--acp`/`--gateway` are embedding hosts, and the rest print and exit. Only a bare
// invocation — optionally with `--prompt`, which auto-submits into the TUI — is the
// interactive session Orca hosts.
const HEADLESS_FLAGS = new Set([
  '--task',
  '--acp',
  '--gateway',
  '--gateway-status',
  '--gateway-stop',
  '--version',
  '--help',
  '-h'
])

// Why enumerate the booleans rather than the value-takers: an unrecognized flag has to
// guess, and guessing "takes no value" makes the NEXT token read as the positional batch
// task — which would strip a live pane of its agent identity for good. Guessing "takes a
// value" only risks a phantom row that clears when the process exits. Junie's boolean set
// is short and stable; its value-taking options are many and grow with every release.
const BOOLEAN_FLAGS = new Set([
  '--brave',
  '--plan',
  '--resume',
  '--review',
  '--goal',
  '--demo',
  '--demo-host',
  '--verbose',
  '--use-local-cache',
  '--skip-update-check',
  ...HEADLESS_FLAGS
])

export function isJunieHeadlessOneShotCommand(tokens: readonly string[]): boolean {
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index]
    const name = optionName(token)
    if (HEADLESS_FLAGS.has(name)) {
      return true
    }
    if (token.startsWith('-')) {
      const next = tokens[index + 1]
      // An attached `=value` carries its own argument; a following flag is never one.
      if (!BOOLEAN_FLAGS.has(name) && !token.includes('=') && next && !next.startsWith('-')) {
        index += 1
      }
      continue
    }
    // Positional token = batch task text (or a one-shot subcommand like `auth`).
    return true
  }
  return false
}
