import { claudeBackgroundArgs } from './claude-background-run-isolation'
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
      // Claude -p accepts large prompts on stdin when no positional prompt is supplied.
      promptDelivery: 'stdin',
      buildArgs: ({ model, thinkingLevel, strictMcp, userArgs }) => [
        '-p',
        '--output-format',
        'text',
        '--model',
        model,
        '--permission-mode',
        'plan',
        ...(thinkingLevel ? ['--effort', thinkingLevel] : []),
        ...claudeBackgroundArgs(strictMcp, userArgs)
      ],
      singletonOptions: [['--model']],
      modelSource: 'dynamic',
      // list_models reads the picker without a listing subcommand; older CLIs exit 0 with control errors, retaining fallback models.
      modelDiscovery: {
        binary: 'claude',
        args: [...CLAUDE_MODEL_LIST_ARGS],
        stdinPayload: CLAUDE_MODEL_LIST_STDIN,
        parse: parseClaudeModels
      },
      models: [
        {
          // Use provider/account aliases; Bedrock/Vertex may reject hardcoded version IDs.
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
      // codex exec reads stdin without prompt argv, avoiding Windows/SSH/POSIX size limits for staged diffs.
      promptDelivery: 'stdin',
      buildArgs: ({ model, thinkingLevel }) => [
        'exec',
        // Text generation needs no persisted session or workspace writes; use ephemeral read-only mode.
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
      // Match the official picker’s descending version order.
      models: [
        {
          id: 'gpt-5.6-terra',
          label: 'GPT-5.6 Terra',
          thinkingLevels: OPENAI_THINKING_LEVELS,
          defaultThinkingLevel: 'low'
        },
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
          // Spark accepts reasoning effort (default medium); unsupported-model refusals concern account tier, not effort.
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
      defaultModelId: 'gpt-5.6-terra'
    },
    opencode: {
      id: 'opencode',
      label: 'OpenCode',
      binary: 'opencode',
      // OpenCode stdin avoids cross-platform argv limits for large staged diffs.
      promptDelivery: 'stdin',
      buildArgs: ({ model, thinkingLevel }) => [
        'run',
        ...(model && model !== 'default' ? ['--model', model] : []),
        '--agent',
        'build',
        '--format',
        'json',
        ...(thinkingLevel ? ['--variant', thinkingLevel] : [])
      ],
      singletonOptions: [['--model', '-m'], ['--agent'], ['--format'], ['--variant']],
      modelSource: 'dynamic',
      modelDiscovery: { binary: 'opencode', args: ['models'], parse: parseLineModels },
      models: [
        { id: 'default', label: 'Config default' },
        {
          id: 'opencode/gpt-5.4-mini',
          label: 'OpenCode GPT 5.4 Mini',
          ...withOpenAiThinking('gpt-5.4-mini')
        }
      ],
      defaultModelId: 'default'
    },
    opencode2: {
      id: 'opencode2',
      label: 'OpenCode 2',
      binary: 'opencode2',
      promptDelivery: 'stdin',
      buildArgs: ({ model, thinkingLevel }) => [
        'run',
        ...(model && model !== 'default'
          ? ['--model', thinkingLevel ? `${model}#${thinkingLevel}` : model]
          : []),
        '--agent',
        'build',
        '--format',
        'json'
      ],
      singletonOptions: [['--model', '-m'], ['--agent'], ['--format']],
      modelSource: 'dynamic',
      modelDiscovery: { binary: 'opencode2', args: ['models'], parse: parseLineModels },
      models: [
        { id: 'default', label: 'Config default' },
        {
          id: 'opencode/gpt-5.4-mini',
          label: 'OpenCode GPT 5.4 Mini',
          ...withOpenAiThinking('gpt-5.4-mini')
        }
      ],
      defaultModelId: 'default'
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
        '--no-skills',
        '--no-context-files',
        '--mode',
        'text',
        ...(model && model !== 'default' ? ['--model', model] : []),
        ...(thinkingLevel ? ['--thinking', thinkingLevel] : [])
      ],
      modelSource: 'dynamic',
      modelDiscovery: { binary: 'pi', args: ['--list-models'], parse: parsePiModels },
      models: [
        {
          // Let Pi choose its configured provider instead of forcing Copilot credentials during automation.
          id: 'default',
          label: 'Config default'
        }
      ],
      defaultModelId: 'default'
    }
  }
}
