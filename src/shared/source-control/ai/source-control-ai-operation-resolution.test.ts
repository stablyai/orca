import { describe, expect, it } from 'vitest'
import type { TuiAgent } from '../../agent-launch/catalog/tui-agent'
import { getDefaultSourceControlAiSettings } from './settings/source-control-ai-settings'
import { resolveCommitMessageAgentChoice } from './generation/commit-message-agent-spec'
import {
  isInheritedAgentUnavailable,
  resolveSourceControlAiForOperation,
  type SourceControlAiSettingsInput
} from './source-control-ai-operation-resolution'
import type { AiTextOperation } from './settings/source-control-ai-settings-types'

type Result = ReturnType<typeof resolveSourceControlAiForOperation>

function resolve(operation: AiTextOperation, settings: SourceControlAiSettingsInput): Result {
  return resolveSourceControlAiForOperation({ settings, operation })
}

function inherited(
  defaultTuiAgent: TuiAgent | 'blank' | undefined,
  disabledTuiAgents: TuiAgent[] = []
): SourceControlAiSettingsInput {
  return {
    defaultTuiAgent,
    disabledTuiAgents,
    sourceControlAi: getDefaultSourceControlAiSettings()
  }
}

function withBranchAgent(agentId: TuiAgent): SourceControlAiSettingsInput {
  const sourceControlAi = getDefaultSourceControlAiSettings()
  sourceControlAi.actions = {
    ...sourceControlAi.actions,
    branchName: { commandInputTemplate: '{basePrompt}', agentId }
  }
  return { defaultTuiAgent: 'codex', sourceControlAi }
}

const agentOf = (result: Result) => (result.ok ? result.value.params.agentId : null)
const skips = (result: Result) => !result.ok && isInheritedAgentUnavailable(result)

describe('resolveSourceControlAiForOperation inherited agent', () => {
  it('runs an inherited default launch agent that can generate text', () => {
    expect(agentOf(resolve('branchName', inherited('codex')))).toBe('codex')
  })

  it.each<TuiAgent>(['gemini', 'claude-agent-teams', 'droid'])(
    'marks an enabled inherited %s that cannot generate text, without rerouting to Claude',
    (agent) => {
      const branch = resolve('branchName', inherited(agent))
      const chat = resolve('conversationName', inherited(agent))
      expect(branch).toMatchObject({ ok: false, errorCode: 'sourceControlAgentUnsupported' })
      expect(chat).toMatchObject({ ok: false, errorCode: 'chatNameAgentUnsupported' })
      expect(skips(branch)).toBe(true)
      expect(skips(chat)).toBe(true)
    }
  )

  it('marks inherited Amp for branch names but runs it for chat names', () => {
    const branch = resolve('branchName', inherited('amp'))
    expect(branch).toMatchObject({ ok: false, errorCode: 'agentCannotGenerateBranchName' })
    expect(skips(branch)).toBe(true)
    expect(agentOf(resolve('conversationName', inherited('amp')))).toBe('amp')
  })

  it.each<[string, SourceControlAiSettingsInput]>([
    ['absent', inherited(undefined)],
    ['blank', inherited('blank')],
    ['disabled', inherited('gemini', ['gemini'])]
  ])('keeps the Claude fallback for an %s default launch agent', (_label, settings) => {
    expect(agentOf(resolve('branchName', settings))).toBe('claude')
    expect(agentOf(resolve('conversationName', settings))).toBe('claude')
  })

  it.each<[string, SourceControlAiSettingsInput]>([
    ['a blank', inherited('blank', ['claude'])],
    ['a disabled', inherited('gemini', ['gemini', 'claude'])]
  ])('keeps the error actionable for %s default with Claude disabled', (_label, settings) => {
    const branch = resolve('branchName', settings)
    expect(branch).toMatchObject({ ok: false, errorCode: 'sourceControlAgentUnsupported' })
    expect(skips(branch)).toBe(false)
    expect(skips(resolve('conversationName', settings))).toBe(false)
  })

  it('does not mark an explicitly chosen agent that cannot run the action', () => {
    const result = resolve('branchName', withBranchAgent('amp'))
    expect(result).toMatchObject({ ok: false, errorCode: 'agentCannotGenerateBranchName' })
    expect(skips(result)).toBe(false)
  })
})

describe('resolveCommitMessageAgentChoice for an action picker', () => {
  it('shows inherited Amp as unusable for branch names but usable for chat names', () => {
    expect(resolveCommitMessageAgentChoice(null, 'amp', [], 'branchName')).toBeNull()
    expect(resolveCommitMessageAgentChoice(null, 'amp', [], 'conversationName')).toBe('amp')
  })

  it('keeps explicit agents and callers without an action unchanged', () => {
    expect(resolveCommitMessageAgentChoice('amp', 'codex', [], 'branchName')).toBe('amp')
    expect(resolveCommitMessageAgentChoice(null, 'amp', [])).toBe('amp')
    expect(resolveCommitMessageAgentChoice(null, 'blank', [], 'branchName')).toBe('claude')
  })
})
