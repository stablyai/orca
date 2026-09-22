import type { TuiAgentConfig } from './tui-agent-config'

// The Desktop bundle exposes a prompt-only runtime. Keep it out of the
// interactive path unless the installed `zcode` identifies itself as the
// independently packaged TUI client.
const ZCODE_DARWIN_LAUNCH = [
  "/bin/sh -c 'prompt_only=0;",
  'for arg do [ "$arg" = "--prompt" ] && prompt_only=1; done;',
  'if command -v zcode >/dev/null 2>&1;',
  'then if zcode --version 2>&1 | grep -q "^zcode-app-cli "; then exec zcode "$@"; fi;',
  'if [ "$prompt_only" -eq 1 ]; then exec zcode "$@"; fi; fi;',
  'if [ "$prompt_only" -eq 1 ]',
  '&& [ -x /Applications/ZCode.app/Contents/MacOS/ZCode ]',
  '&& [ -f /Applications/ZCode.app/Contents/Resources/glm/zcode.cjs ];',
  'then ELECTRON_RUN_AS_NODE=1 exec /Applications/ZCode.app/Contents/MacOS/ZCode',
  '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs "$@"; fi;',
  'printf "%s\\n" "ZCode Desktop supports prompted one-shot tasks only; install an interactive zcode-app-cli for an empty TUI session." >&2;',
  "exit 64' --"
].join(' ')

export const ZCODE_TUI_AGENT_CONFIG: TuiAgentConfig = {
  detectCmd: 'zcode',
  detectCmdAliases: ['/Applications/ZCode.app/Contents/MacOS/ZCode'],
  launchCmd: 'zcode',
  launchCmdByPlatform: { darwin: ZCODE_DARWIN_LAUNCH },
  expectedProcess: 'zcode-cli',
  promptInjectionMode: 'flag-prompt'
}
