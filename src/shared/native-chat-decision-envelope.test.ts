import { describe, expect, it } from 'vitest'
import { parseNativeChatDecisionEnvelope } from './native-chat-decision-envelope'

const question = JSON.stringify({
  questions: [{ question: 'Pick one', options: [{ label: 'A' }, { label: 'B' }] }]
})

describe('parseNativeChatDecisionEnvelope', () => {
  it('reads an absent or empty prompt as none', () => {
    expect(parseNativeChatDecisionEnvelope(undefined)).toEqual({ kind: 'none' })
    expect(parseNativeChatDecisionEnvelope(null)).toEqual({ kind: 'none' })
    expect(parseNativeChatDecisionEnvelope('  ')).toEqual({ kind: 'none' })
  })

  it('reads a question through the question parsers', () => {
    expect(parseNativeChatDecisionEnvelope(question, 'AskUserQuestion')).toMatchObject({
      kind: 'question',
      prompt: { questions: [{ question: 'Pick one' }] }
    })
  })

  it('reads an approval with its summary and a known subject', () => {
    const prompt = JSON.stringify({
      approval: {
        tool: 'ExitPlanMode',
        summary: 'plan',
        subject: { kind: 'plan', text: '1. Do it', filePath: '/p.md' }
      }
    })
    expect(parseNativeChatDecisionEnvelope(prompt)).toEqual({
      kind: 'approval',
      tool: 'ExitPlanMode',
      summary: 'plan',
      subject: { kind: 'plan', text: '1. Do it', filePath: '/p.md' }
    })
  })

  it('reads non-JSON as no envelope (a truncated or prose prompt)', () => {
    expect(parseNativeChatDecisionEnvelope('Do you approve?')).toEqual({ kind: 'none' })
    expect(parseNativeChatDecisionEnvelope('{"questions":[{"question":"Pick')).toEqual({
      kind: 'none'
    })
  })

  it('reads raw tool input with no arm as no envelope', () => {
    const prompt = JSON.stringify({ action: 'delete the staging bucket', reason: 'cleanup' })
    expect(parseNativeChatDecisionEnvelope(prompt, 'request_permission')).toEqual({ kind: 'none' })
  })

  it('treats an unknown arm as unsupported and keeps its own words', () => {
    const prompt = JSON.stringify({ choice: { title: 'Implement this plan?', options: ['Yes'] } })
    expect(parseNativeChatDecisionEnvelope(prompt)).toEqual({
      kind: 'unsupported',
      text: 'Implement this plan?'
    })
  })

  it('reads a known approval arm that does not parse as no envelope', () => {
    expect(parseNativeChatDecisionEnvelope(JSON.stringify({ approval: { summary: 'x' } }))).toEqual(
      { kind: 'none' }
    )
    const badPlan = JSON.stringify({ approval: { tool: 'Plan', subject: { kind: 'plan' } } })
    expect(parseNativeChatDecisionEnvelope(badPlan)).toEqual({ kind: 'none' })
  })

  it('treats an approval with an unknown subject kind as unsupported', () => {
    const prompt = JSON.stringify({
      approval: { tool: 'Plan', subject: { kind: 'future-subject', text: 'Review this' } }
    })
    expect(parseNativeChatDecisionEnvelope(prompt)).toEqual({
      kind: 'unsupported',
      text: 'Review this'
    })
  })

  it('reads a question arm that does not parse as no envelope', () => {
    expect(
      parseNativeChatDecisionEnvelope(JSON.stringify({ questions: [] }), 'AskUserQuestion')
    ).toEqual({ kind: 'none' })
  })

  it('clips long display text', () => {
    const prompt = JSON.stringify({ choice: { title: 'x'.repeat(2_000) } })
    const parsed = parseNativeChatDecisionEnvelope(prompt)
    expect(parsed.kind === 'unsupported' ? parsed.text?.length : 0).toBe(500)
  })
})
