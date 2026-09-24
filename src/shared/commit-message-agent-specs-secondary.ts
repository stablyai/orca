import type { TuiAgent } from './tui-agent'
import type {
  CommitMessageAgentSpec,
  CommitMessageModel,
  ThinkingLevel
} from './commit-message-agent-spec'

type SecondaryAgentSpecDeps = {
  BASIC_THINKING_LEVELS: ThinkingLevel[]
  OPENAI_THINKING_LEVELS: ThinkingLevel[]
  parseCursorModels: (stdout: string) => CommitMessageModel[]
  parseAntigravityModels: (stdout: string) => CommitMessageModel[]
  parseLineModels: (stdout: string) => CommitMessageModel[]
}

export function buildSecondaryCommitMessageAgentSpecs({
  BASIC_THINKING_LEVELS,
  OPENAI_THINKING_LEVELS,
  parseCursorModels,
  parseAntigravityModels,
  parseLineModels
}: SecondaryAgentSpecDeps): Partial<Record<TuiAgent, CommitMessageAgentSpec>> {
  return {
    amp: {
      id: 'amp',
      label: 'Amp',
      binary: 'amp',
      promptDelivery: 'stdin',
      buildArgs: ({ model, thinkingLevel }) => [
        '--execute',
        '--no-notifications',
        '--no-ide',
        '--no-jetbrains',
        '--mode',
        model,
        ...(thinkingLevel ? ['--effort', thinkingLevel] : [])
      ],
      // Amp selects the model with `--mode`, not `--model`.
      singletonOptions: [['--mode']],
      modelSource: 'static',
      models: [
        { id: 'smart', label: 'Smart' },
        { id: 'rush', label: 'Rush' },
        {
          id: 'large',
          label: 'Large',
          thinkingLevels: BASIC_THINKING_LEVELS,
          defaultThinkingLevel: 'low'
        },
        {
          id: 'deep',
          label: 'Deep',
          thinkingLevels: BASIC_THINKING_LEVELS,
          defaultThinkingLevel: 'low'
        }
      ],
      defaultModelId: 'smart'
    },
    cursor: {
      id: 'cursor',
      label: 'Cursor',
      binary: 'cursor-agent',
      promptDelivery: 'argv',
      buildArgs: ({ prompt, model }) => [
        '--print',
        '--mode',
        'ask',
        '--trust',
        '--output-format',
        'text',
        '--model',
        model,
        prompt
      ],
      modelSource: 'dynamic',
      modelDiscovery: { binary: 'cursor-agent', args: ['--list-models'], parse: parseCursorModels },
      models: [{ id: 'auto', label: 'Auto' }],
      defaultModelId: 'auto'
    },
    kimi: {
      id: 'kimi',
      label: 'Kimi',
      binary: 'kimi',
      // Why: kimi-code accepts the generation prompt only via --prompt/-p (Claude's
      // --print is rejected). Deliver on argv so --prompt receives the text (#11669).
      promptDelivery: 'argv',
      buildArgs: ({ prompt, model, thinkingLevel }) => [
        '--prompt',
        prompt,
        '--quiet',
        ...(model && model !== 'default' ? ['--model', model] : []),
        ...(thinkingLevel === 'on'
          ? ['--thinking']
          : thinkingLevel === 'off'
            ? ['--no-thinking']
            : [])
      ],
      modelSource: 'static',
      models: [
        { id: 'default', label: 'Config default' },
        {
          // Why: Kimi resolves its managed model by provider/model; bare model
          // names are rejected by the CLI with "LLM not set".
          id: 'kimi-code/kimi-for-coding',
          label: 'Kimi K2.6',
          thinkingLevels: [
            { id: 'on', label: 'On' },
            { id: 'off', label: 'Off' }
          ],
          defaultThinkingLevel: 'on'
        }
      ],
      defaultModelId: 'default'
    },
    muse: {
      id: 'muse',
      label: 'Muse',
      binary: 'muse',
      // Muse's `exec` subcommand accepts a positional prompt. Keep Source
      // Control AI one-shot and workspace-read-only, matching the other text
      // generators rather than launching the interactive TUI.
      promptDelivery: 'argv',
      buildArgs: ({ prompt, model, thinkingLevel }) => [
        'exec',
        '--no-session-log',
        '--approval-mode',
        'never',
        '--disable-sandbox',
        '--disable-shell',
        '--disable-write',
        '--disable-web-tools',
        ...(model && model !== 'default' ? ['--model', model] : []),
        ...(thinkingLevel ? ['--reasoning-effort', thinkingLevel] : []),
        '--',
        prompt
      ],
      singletonOptions: [['--model'], ['--reasoning-effort']],
      modelSource: 'static',
      models: [{ id: 'default', label: 'Config default' }],
      defaultModelId: 'default'
    },
    copilot: {
      id: 'copilot',
      label: 'GitHub Copilot',
      binary: 'copilot',
      promptDelivery: 'argv',
      buildArgs: ({ prompt, model, thinkingLevel }) => [
        '--prompt',
        prompt,
        '--silent',
        '--stream',
        'off',
        '--no-custom-instructions',
        '--model',
        model,
        ...(thinkingLevel ? ['--effort', thinkingLevel] : [])
      ],
      modelSource: 'static',
      // Why: Copilot CLI's picker is policy-filtered per account/org. Keep the
      // full hosted CLI catalog here so users can select models enabled for them.
      models: [
        { id: 'auto', label: 'Auto' },
        {
          id: 'claude-haiku-4.5',
          label: 'Claude Haiku 4.5'
        },
        {
          id: 'claude-sonnet-4.5',
          label: 'Claude Sonnet 4.5'
        },
        {
          id: 'claude-sonnet-4.6',
          label: 'Claude Sonnet 4.6'
        },
        {
          id: 'claude-opus-4.5',
          label: 'Claude Opus 4.5'
        },
        {
          id: 'claude-opus-4.6',
          label: 'Claude Opus 4.6'
        },
        {
          id: 'claude-opus-4.6-fast',
          label: 'Claude Opus 4.6 Fast'
        },
        {
          id: 'claude-opus-4.7',
          label: 'Claude Opus 4.7'
        },
        {
          id: 'gpt-4.1',
          label: 'GPT-4.1'
        },
        {
          id: 'gpt-5-mini',
          label: 'GPT-5 Mini',
          thinkingLevels: OPENAI_THINKING_LEVELS,
          defaultThinkingLevel: 'low'
        },
        {
          id: 'gpt-5.2',
          label: 'GPT-5.2',
          thinkingLevels: OPENAI_THINKING_LEVELS,
          defaultThinkingLevel: 'low'
        },
        {
          id: 'gpt-5.2-codex',
          label: 'GPT-5.2 Codex',
          thinkingLevels: OPENAI_THINKING_LEVELS,
          defaultThinkingLevel: 'low'
        },
        {
          id: 'gpt-5.3-codex',
          label: 'GPT-5.3 Codex',
          thinkingLevels: OPENAI_THINKING_LEVELS,
          defaultThinkingLevel: 'low'
        },
        {
          id: 'gpt-5.4',
          label: 'GPT-5.4',
          thinkingLevels: OPENAI_THINKING_LEVELS,
          defaultThinkingLevel: 'low'
        },
        {
          id: 'gpt-5.4-mini',
          label: 'GPT-5.4 Mini',
          thinkingLevels: OPENAI_THINKING_LEVELS,
          defaultThinkingLevel: 'low'
        },
        {
          id: 'gpt-5.5',
          label: 'GPT-5.5',
          thinkingLevels: OPENAI_THINKING_LEVELS,
          defaultThinkingLevel: 'low'
        }
      ],
      defaultModelId: 'gpt-5.4'
    },
    antigravity: {
      id: 'antigravity',
      label: 'Antigravity',
      binary: 'agy',
      // agy's --print takes the prompt as its value (#19539, #14059). Deliver on argv
      // using `--print=<value>` so a leading-dash prompt binds to the flag instead of
      // being parsed as its own option, and --sandbox/--model stay separate options.
      promptDelivery: 'argv',
      buildArgs: ({ prompt, model, thinkingLevel }) => [
        `--print=${prompt}`,
        '--sandbox',
        ...(model && model !== 'default' ? ['--model', model] : []),
        ...(thinkingLevel ? ['--effort', thinkingLevel] : [])
      ],
      singletonOptions: [['--model'], ['--effort']],
      modelSource: 'dynamic',
      modelDiscovery: { binary: 'agy', args: ['models'], parse: parseAntigravityModels },
      models: [{ id: 'default', label: 'Config default' }],
      defaultModelId: 'default'
    },
    jcode: {
      id: 'jcode',
      label: 'Jcode',
      binary: 'jcode',
      // Why: `jcode run` takes the message as a positional argv argument and has no
      // stdin prompt mode, so Source Control AI prompts ride argv (fine for branch
      // naming and small diffs, argv-capped on Windows).
      promptDelivery: 'argv',
      buildArgs: ({ prompt, model }) => [
        // Why: these are jcode global options, so they must precede the subcommand;
        // clap rejects them after `run`.
        '--no-update',
        '--quiet',
        '--no-selfdev',
        // Why: the prompt here IS a staged patch, i.e. attacker-influenced text, and
        // jcode would otherwise expose shell/read/write/MCP to it. `none` resolves to
        // an empty allowed-tool set in jcode's config (tools.rs `base_allowed_tools`),
        // which drops `mcp` too since MCP is exposed as a tool. Matches the read-only
        // posture the other generators already take (claude plan, codex read-only).
        '--tool-profile',
        'none',
        ...(model && model !== 'default' ? ['--model', model] : []),
        'run',
        '--json',
        prompt
      ],
      singletonOptions: [['--model']],
      modelSource: 'dynamic',
      // Why: `jcode model list` prints one bare model id per line, which is exactly
      // what parseLineModels reads. Discovering beats a hardcoded list because
      // jcode's catalog spans every provider the user has authenticated.
      modelDiscovery: {
        binary: 'jcode',
        args: ['--no-update', '--quiet', 'model', 'list'],
        parse: parseLineModels
      },
      // Why: `default` is not a jcode model id — it is the sentinel that omits
      // --model so jcode uses the model from its own config.toml, rather than Orca
      // pinning a provider the user may not be logged in to.
      models: [{ id: 'default', label: 'Config default' }],
      defaultModelId: 'default'
    }
  }
}
