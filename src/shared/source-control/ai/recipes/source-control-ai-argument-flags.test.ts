import { expect, it } from 'vitest'
import {
  COMMIT_MESSAGE_AGENT_SPECS,
  listCommitMessageAgentIds
} from '../generation/commit-message-agent-spec'
import { removeSourceControlAiArgumentFlag } from './source-control-ai-argument-flags'

it('removes each text CLI model/effort spelling without changing unrelated Arguments', () => {
  const flags: Record<string, { model: string[]; effort: string[] }> = {
    omp: {
      model: ['--model provider/model', '--model=provider/model'],
      effort: ['--thinking high']
    },
    claude: {
      model: ['--model opus', '--model=opus'],
      effort: ['--effort high', '--effort=high']
    },
    codex: {
      model: ['--model next', '-m next', '--model=next', '-c model="next"'],
      effort: [
        '-c model_reasoning_effort="low"',
        '--config model_reasoning_effort=high',
        '--config=model_reasoning_effort=high'
      ]
    },
    opencode: {
      model: ['-m provider/model', '--model=provider/model'],
      effort: ['--variant high', '--variant=high']
    },
    opencode2: {
      model: ['--model provider/model#high', '-m=provider/model#high'],
      effort: ['--model provider/model#high', '--model=provider/model']
    },
    pi: { model: ['--model provider/model'], effort: ['--thinking high', '--thinking=high'] },
    amp: { model: ['--mode smart', '--mode=deep'], effort: ['--effort high'] },
    cursor: { model: ['--model auto', '--model=auto'], effort: [] },
    kimi: { model: ['--model kimi-code/k3', '-m kimi-code/k3'], effort: [] },
    muse: {
      model: ['--model next'],
      effort: ['--reasoning-effort high', '--reasoning-effort=high']
    },
    dsh: { model: [], effort: [] },
    copilot: { model: ['--model gpt-5.4'], effort: ['--effort high'] },
    antigravity: { model: ['--model next'], effort: ['--effort high'] },
    jcode: { model: ['--model next'], effort: [] }
  }
  expect(Object.keys(flags).sort()).toEqual(listCommitMessageAgentIds().sort())
  for (const spec of Object.values(COMMIT_MESSAGE_AGENT_SPECS)) {
    if (!spec) {
      continue
    }
    for (const field of ['model', 'effort'] as const) {
      expect(spec[field === 'model' ? 'modelFlag' : 'effortFlag'].length > 0).toBe(
        flags[spec.id][field].length > 0
      )
      for (const argument of flags[spec.id][field]) {
        expect(
          removeSourceControlAiArgumentFlag(`${argument} --other 'keep quoted'`, spec, field)
        ).toEqual({
          agentArgs: "--other 'keep quoted'",
          unrecognized: false
        })
      }
    }
  }
  const codex = COMMIT_MESSAGE_AGENT_SPECS.codex!
  expect(
    removeSourceControlAiArgumentFlag(
      '-c sandbox_mode="read-only" --config model_reasoning_effort=low --model keep',
      codex,
      'effort'
    )
  ).toEqual({
    agentArgs: '-c sandbox_mode="read-only"  --model keep',
    unrecognized: false
  })
  for (const agentArgs of ['--model', '--model= --other keep', '--model "unfinished']) {
    expect(removeSourceControlAiArgumentFlag(agentArgs, codex, 'model')).toEqual({
      agentArgs,
      unrecognized: true
    })
  }
  const quotedOperand = '--append-system-prompt "--model" --model opus -- tail --model keep'
  expect(
    removeSourceControlAiArgumentFlag(quotedOperand, COMMIT_MESSAGE_AGENT_SPECS.claude!, 'model')
  ).toEqual({
    agentArgs: '--append-system-prompt "--model"  -- tail --model keep',
    unrecognized: false
  })
})

it('requires an equals delimiter before treating a Codex config operand as an owned field', () => {
  const spec = COMMIT_MESSAGE_AGENT_SPECS.codex!
  for (const [field, nearMatch, key] of [
    ['model', '-c models --verbose', 'model'],
    ['effort', '--config model_reasoning_efforts --verbose', 'model_reasoning_effort']
  ] as const) {
    expect(removeSourceControlAiArgumentFlag(nearMatch, spec, field)).toEqual({
      agentArgs: nearMatch,
      unrecognized: false
    })
    const mixed = `-c '${key}s' --config '${key} = high' --verbose`
    expect(removeSourceControlAiArgumentFlag(mixed, spec, field)).toEqual({
      agentArgs: `-c '${key}s'  --verbose`,
      unrecognized: false
    })
    for (const operand of [key, `${key}=`]) {
      const agentArgs = `--config '${operand}' --verbose`
      expect(removeSourceControlAiArgumentFlag(agentArgs, spec, field)).toEqual({
        agentArgs,
        unrecognized: true
      })
    }
  }
})
