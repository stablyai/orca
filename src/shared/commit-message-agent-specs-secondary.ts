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
      // kimi-code requires --prompt/-p text on argv; Claude-style --print is rejected (#11669).
      promptDelivery: 'argv',
      // Why: Kimi Code has no --quiet/--thinking/--no-thinking; -p alone is headless (#14771).
      buildArgs: ({ prompt, model }) => [
        '--prompt',
        prompt,
        ...(model && model !== 'default' ? ['--model', model] : [])
      ],
      modelSource: 'static',
      models: [
        { id: 'default', label: 'Config default' },
        {
          // Kimi requires provider/model IDs; bare names fail with LLM not set.
          id: 'kimi-code/kimi-for-coding',
          label: 'Kimi K2.6'
        }
      ],
      defaultModelId: 'default'
    },
    muse: {
      id: 'muse',
      label: 'Muse',
      binary: 'muse',
      // Muse exec takes a positional prompt; keep generation one-shot and read-only.
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
    dsh: {
      id: 'dsh',
      label: 'DeepSeek Harness',
      binary: 'dsh',
      // DSH headless runs one persisted session, prints and exits. Use stdin to hide diffs from process listings and avoid argv limits. 0.1.5-rc.1 requires explicit - even with piped stdin.
      promptDelivery: 'stdin',
      buildArgs: () => ['--profile', 'headless', '-'],
      // Why: the launcher owns `--profile`; a second one would boot a different profile.
      singletonOptions: [['--profile']],
      modelSource: 'static',
      // Headless has no --model; its llm-deepseek profile row owns selection, so offer only configured default.
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
      // Copilot filters the picker by account/org policy; retain the full hosted catalog for permitted selections.
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
      // Empty --print selects stream input without consuming the next flag (agy >= 1.1.15).
      promptDelivery: 'stdin',
      buildArgs: ({ model, thinkingLevel }) => [
        '--print=',
        '--input-format=stream-json',
        '--output-format=stream-json',
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
      // jcode run supports positional argv only; large diffs remain subject to Windows argv limits.
      promptDelivery: 'argv',
      buildArgs: ({ prompt, model }) => [
        // clap accepts these global flags only before run.
        '--no-update',
        '--quiet',
        '--no-selfdev',
        // Staged patches are attacker-influenced; none removes shell/read/write and MCP via tools.rs base_allowed_tools, matching read-only siblings.
        '--tool-profile',
        'none',
        ...(model && model !== 'default' ? ['--model', model] : []),
        'run',
        '--json',
        prompt
      ],
      singletonOptions: [['--model']],
      modelSource: 'dynamic',
      // Read bare model IDs from jcode’s authenticated-provider catalog instead of hardcoding it.
      modelDiscovery: {
        binary: 'jcode',
        args: ['--no-update', '--quiet', 'model', 'list'],
        parse: parseLineModels
      },
      // default omits --model so jcode’s config.toml chooses an authenticated provider; it is not a real model ID.
      models: [{ id: 'default', label: 'Config default' }],
      defaultModelId: 'default'
    }
  }
}
