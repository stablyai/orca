import type { TuiAgent } from './tui-agent'
import type {
  CommitMessageAgentSpec,
  CommitMessageModel,
  ThinkingLevel
} from './commit-message-agent-spec'
import { CLAUDE_MODEL_LIST_ARGS, CLAUDE_MODEL_LIST_STDIN } from './claude-model-list-probe'

type PrimaryAgentSpecDeps = {
  CLAUDE_THINKING_LEVELS: ThinkingLevel[]
  OPENAI_THINKING_LEVELS: ThinkingLevel[]
  parseClaudeModels: (stdout: string) => CommitMessageModel[]
  parseCodexModels: (stdout: string) => CommitMessageModel[]
  parseLineModels: (stdout: string) => CommitMessageModel[]
  parsePiModels: (stdout: string) => CommitMessageModel[]
  withOpenAiThinking: (
    id: string
  ) => Pick<CommitMessageModel, 'thinkingLevels' | 'defaultThinkingLevel'>
}

export function buildPrimaryCommitMessageAgentSpecs({
  CLAUDE_THINKING_LEVELS,
  OPENAI_THINKING_LEVELS,
  parseClaudeModels,
  parseCodexModels,
  parseLineModels,
  parsePiModels,
  withOpenAiThinking
}: PrimaryAgentSpecDeps): Partial<Record<TuiAgent, CommitMessageAgentSpec>> {
  return {
    claude: {
      id: 'claude',
      label: 'Claude',
      binary: 'claude',
      // Why: diffs can be large and `claude -p` reads from stdin natively when no
      // positional prompt is provided.
      promptDelivery: 'stdin',
      buildArgs: ({ model, thinkingLevel }) => [
        '-p',
        '--output-format',
        'text',
        '--model',
        model,
        '--permission-mode',
        'plan',
        ...(thinkingLevel ? ['--effort', thinkingLevel] : [])
      ],
      modelSource: 'dynamic',
      // Why: the Claude CLI has no listing subcommand; one list_models control
      // request over --print stream-json returns the /model picker catalog.
      // Older CLIs answer with a control error and exit 0, keeping the fallback.
      modelDiscovery: {
        binary: 'claude',
        args: [...CLAUDE_MODEL_LIST_ARGS],
        stdinPayload: CLAUDE_MODEL_LIST_STDIN,
        parse: parseClaudeModels
      },
      models: [
        {
          // Why: Claude Code aliases track the account/provider's supported
          // model IDs; hardcoded version IDs can be rejected by Bedrock/Vertex.
          id: 'haiku',
          label: 'Haiku'
        },
        {
          id: 'sonnet',
          label: 'Sonnet',
          thinkingLevels: CLAUDE_THINKING_LEVELS,
          defaultThinkingLevel: 'low'
        },
        {
          id: 'opus',
          label: 'Opus',
          thinkingLevels: CLAUDE_THINKING_LEVELS,
          defaultThinkingLevel: 'low'
        }
      ],
      defaultModelId: 'sonnet'
    },
    codex: {
      id: 'codex',
      label: 'Codex',
      binary: 'codex',
      // Why: `codex exec` reads stdin when no prompt arg is supplied. Commit
      // prompts include large staged diffs, so argv would exceed Windows and
      // some SSH/POSIX command-line limits.
      promptDelivery: 'stdin',
      buildArgs: ({ model, thinkingLevel }) => [
        'exec',
        // Why: commit-message generation needs text only, not a persisted agent
        // session or workspace writes. Match the safe git-text mode used by
        // local-first coding agents.
        '--ephemeral',
        '--skip-git-repo-check',
        '-s',
        'read-only',
        '--model',
        model,
        ...(thinkingLevel ? ['-c', `model_reasoning_effort=${thinkingLevel}`] : [])
      ],
      // `-c` is intentionally absent: Codex accepts repeated overrides.
      singletonOptions: [['--model', '-m']],
      modelSource: 'dynamic',
      modelDiscovery: {
        binary: 'codex',
        args: ['debug', 'models'],
        parse: parseCodexModels
      },
      // Why: ordered to match the official `codex` model picker — descending
      // by version so the frontier model lands on top and legacy models trail.
      models: [
        {
          id: 'gpt-5.5',
          label: 'GPT-5.5',
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
          id: 'gpt-5.3-codex',
          label: 'GPT-5.3 Codex',
          thinkingLevels: OPENAI_THINKING_LEVELS,
          defaultThinkingLevel: 'low'
        },
        {
          // Why: Codex's Spark variant accepts `model_reasoning_effort` (the
          // CLI banner reports "reasoning effort: medium" by default); the
          // gating that surfaces "model not supported" is on the account
          // tier, not the effort flag.
          id: 'gpt-5.3-codex-spark',
          label: 'GPT-5.3 Codex Spark',
          thinkingLevels: OPENAI_THINKING_LEVELS,
          defaultThinkingLevel: 'low'
        },
        {
          id: 'gpt-5.2',
          label: 'GPT-5.2',
          thinkingLevels: OPENAI_THINKING_LEVELS,
          defaultThinkingLevel: 'low'
        }
      ],
      defaultModelId: 'gpt-5.5'
    },
    opencode: {
      id: 'opencode',
      label: 'OpenCode',
      binary: 'opencode',
      // Why: Source Control AI prompts can include large staged diffs; OpenCode
      // accepts the prompt on stdin, which avoids cross-platform argv limits.
      promptDelivery: 'stdin',
      buildArgs: ({ model, thinkingLevel }) => [
        'run',
        '--model',
        model,
        '--agent',
        'build',
        '--format',
        'default',
        ...(thinkingLevel ? ['--variant', thinkingLevel] : [])
      ],
      singletonOptions: [['--model', '-m'], ['--agent'], ['--format'], ['--variant']],
      modelSource: 'dynamic',
      modelDiscovery: { binary: 'opencode', args: ['models'], parse: parseLineModels },
      models: [
        {
          // Why: OpenCode's hosted GPT models can require workspace billing even
          // when `opencode models` lists them. This free model is available in
          // discovery and works as a usable out-of-the-box default.
          id: 'opencode/deepseek-v4-flash-free',
          label: 'OpenCode DeepSeek V4 Flash Free'
        },
        {
          id: 'opencode/gpt-5.4-mini',
          label: 'OpenCode GPT 5.4 Mini',
          ...withOpenAiThinking('gpt-5.4-mini')
        }
      ],
      defaultModelId: 'opencode/deepseek-v4-flash-free'
    },
    pi: {
      id: 'pi',
      label: 'Pi',
      binary: 'pi',
      promptDelivery: 'stdin',
      buildArgs: ({ model, thinkingLevel }) => [
        '--print',
        '--no-session',
        '--no-tools',
        '--no-extensions',
        '--no-skills',
        '--no-context-files',
        '--mode',
        'text',
        '--model',
        model,
        ...(thinkingLevel ? ['--thinking', thinkingLevel] : [])
      ],
      modelSource: 'dynamic',
      modelDiscovery: { binary: 'pi', args: ['--list-models'], parse: parsePiModels },
      models: [
        {
          // Why: Pi commonly authenticates through GitHub Copilot locally; using
          // that provider avoids selecting a raw OpenAI model when no key exists.
          id: 'github-copilot/gpt-5.4-mini',
          label: 'Github Copilot GPT 5.4 Mini',
          ...withOpenAiThinking('gpt-5.4-mini')
        }
      ],
      defaultModelId: 'github-copilot/gpt-5.4-mini'
    }
  }
}
