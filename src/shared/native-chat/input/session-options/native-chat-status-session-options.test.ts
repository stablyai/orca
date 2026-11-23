import { expect, it, vi } from 'vitest'
import { getAgentSessionOptionCatalog } from '../../../agent-session/options/agent-session-option-catalog'
import { createNativeChatPtySessionOptions } from './native-chat-pty-session-options'
import {
  takeNativeChatStatusReport,
  type NativeChatStatusReportMemory
} from './native-chat-status-session-options'

const claude = getAgentSessionOptionCatalog('claude')!

function chip(scopeKey: string, dispatchCommand: () => Promise<void> = async () => {}) {
  const memory: NativeChatStatusReportMemory = new Map()
  const surface = createNativeChatPtySessionOptions({
    agent: 'claude',
    scopeKey,
    mode: 'live',
    modelLabel: 'Model',
    dispatchCommand
  })!
  const report = (model: string, effort?: string, sessionId = 'session-a') => {
    const reported = takeNativeChatStatusReport(memory, scopeKey, 'claude', claude, claude.models, {
      model,
      providerSession: { id: sessionId, effort }
    })
    if (reported) {
      surface.reportSessionOptions(reported.values, reported.forNewModel)
    }
  }
  const shown = (id: string) =>
    surface.getSnapshot().find((row) => row.id === id)?.kind.currentValue
  const source = (id: string) => surface.getSnapshot().find((row) => row.id === id)?.valueSource
  return { surface, report, shown, source }
}

it('shows the live Claude effort with its model and follows an /effort change', () => {
  const { report, shown } = chip('status-report-effort')
  report('claude-opus-5-5', 'low')
  expect([shown('model'), shown('effort')]).toEqual(['opus', 'low'])
  report('claude-opus-5-5', 'max')
  expect([shown('model'), shown('effort')]).toEqual(['opus', 'max'])
})

it('keeps a newer model pick when only the reported effort changes', async () => {
  const { surface, report, shown } = chip('status-report-pick')
  report('claude-opus-5-5', 'high')
  await surface.setOption('model', 'sonnet')
  // The hook model stays on Opus until the Stop read; a tool hook already names the new effort.
  report('claude-opus-5-5', 'low')
  expect([shown('model'), shown('effort')]).toEqual(['sonnet', 'low'])
})

it('reports a restarted session afresh, even on the same model', async () => {
  const { surface, report, shown } = chip('status-report-restart')
  report('claude-opus-5-5', 'high')
  await surface.setOption('model', 'sonnet')
  report('claude-opus-5-5', 'high', 'session-b')
  expect(shown('model')).toBe('opus')
})

it('keeps a newer effort pick when only the reported model changes', async () => {
  const { surface, report, shown } = chip('status-report-effort-pick')
  report('claude-opus-5-5', 'high')
  await surface.setOption('model', 'sonnet')
  await surface.setOption('effort', 'low')
  // The statusline confirms Sonnet before a hook reports the new effort.
  report('claude-sonnet-5-5', 'high')
  expect([shown('model'), shown('effort')]).toEqual(['sonnet', 'low'])
})

it('checks a reported effort against the model the session switched to, not the hook model', async () => {
  const { surface, report, shown } = chip('status-report-effort-target')
  report('claude-haiku-5-5', 'high')
  await surface.setOption('model', 'sonnet')
  // Hooks still name Haiku, which offers no effort, while Sonnet runs at Max.
  report('claude-haiku-5-5', 'max')
  expect([shown('model'), shown('effort')]).toEqual(['sonnet', 'max'])
})

it('shows the live effort on a model picked in the chip once the session confirms it', async () => {
  const { surface, report, shown } = chip('status-report-confirmed-pick')
  report('claude-opus-5-5', 'max')
  await surface.setOption('model', 'sonnet')
  report('claude-sonnet-5-5', 'max')
  expect([shown('model'), shown('effort')]).toEqual(['sonnet', 'max'])
})

it('keeps an effort the session reports while a chip model pick is still being sent', async () => {
  let sent: (() => void) | undefined
  const { surface, report, shown } = chip(
    'status-report-mid-dispatch',
    () => new Promise<void>((resolve) => (sent = resolve))
  )
  report('claude-opus-5-5', 'high')
  const pick = surface.setOption('model', 'sonnet')
  await vi.waitFor(() => expect(sent).toBeDefined())
  report('claude-sonnet-5-5', 'max')
  sent!()
  await pick
  expect([shown('model'), shown('effort')]).toEqual(['sonnet', 'max'])
})

it('merges changed host options while preserving phone picks and session reports', async () => {
  const scope = 'applied-seed'
  const launch = { model: 'opus', effort: 'high', fastMode: true }
  const initial = chip(scope)
  const sibling = chip(scope)
  await initial.surface.mergeAppliedSessionOptions(launch)
  await sibling.surface.mergeAppliedSessionOptions(launch)
  expect([initial.shown('effort'), sibling.shown('effort')]).toEqual(['high', 'high'])
  await initial.surface.setOption('fastMode', false)

  let finishDispatch: (() => void) | undefined
  const { surface, report, shown, source } = chip(
    scope,
    () => new Promise<void>((resolve) => (finishDispatch = resolve))
  )
  const fast = () => [shown('fastMode'), source('fastMode')]
  const effort = () => [shown('effort'), source('effort')]
  await surface.mergeAppliedSessionOptions(launch)
  expect(fast()).toEqual([false, 'applied'])
  report('opus')
  expect(effort()).toEqual(['high', 'applied'])
  await surface.mergeAppliedSessionOptions({ ...launch, effort: 'low' })
  expect(effort()).toEqual(['low', 'applied'])
  expect(fast()).toEqual([false, 'applied'])

  const pick = surface.setOption('effort', 'medium')
  await vi.waitFor(() => expect(finishDispatch).toBeDefined())
  const merge = surface.mergeAppliedSessionOptions(launch)
  finishDispatch!()
  await pick
  await merge
  expect(effort()).toEqual(['medium', 'dispatched'])

  report('opus', 'low')
  await surface.mergeAppliedSessionOptions({ ...launch, effort: 'medium' })
  expect(effort()).toEqual(['low', 'reported'])
})
