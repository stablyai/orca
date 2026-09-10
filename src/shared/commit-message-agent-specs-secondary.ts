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
}

export function buildSecondaryCommitMessageAgentSpecs({
  BASIC_THINKING_LEVELS,
  OPENAI_THINKING_LEVELS,
  parseCursorModels,
  parseAntigravityModels
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
      promptDelivery: 'stdin',
      buildArgs: ({ model }) => ['--print', '--sandbox', '--model', model],
      modelSource: 'dynamic',
      modelDiscovery: { binary: 'agy', args: ['models'], parse: parseAntigravityModels },
      models: [
        { id: 'Gemini 3.5 Flash (Medium)', label: 'Gemini 3.5 Flash (Medium)' },
        { id: 'Gemini 3.5 Flash (High)', label: 'Gemini 3.5 Flash (High)' },
        { id: 'Gemini 3.5 Flash (Low)', label: 'Gemini 3.5 Flash (Low)' }
      ],
      defaultModelId: 'Gemini 3.5 Flash (Medium)'
    }
  }
}
