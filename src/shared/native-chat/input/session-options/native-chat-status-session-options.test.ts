import { expect, it, vi } from 'vitest'
import { getAgentSessionOptionCatalog } from '../../../agent-session/options/agent-session-option-catalog'
import { createNativeChatPtySessionOptions } from './native-chat-pty-session-options'
import {
  decodeNativeChatAppliedSessionOptions,
  seedNativeChatAppliedSessionOptions
} from './native-chat-session-option-cache'
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
  const row = (id: string) => surface.getSnapshot().find((option) => option.id === id)
  const shown = (id: string) => row(id)?.kind.currentValue
  const source = (id: string) => row(id)?.valueSource
  return { surface, report, shown, source }
}

it('fills only missing chat options from the launch, including launches without a model', async () => {
  const empty = chip('applied-options-empty')
  const applied = decodeNativeChatAppliedSessionOptions('claude', {
    model: 'opus',
    effort: 'high',
    fastMode: 'true'
  })
  empty.surface.fillAppliedSessionOptions(applied)
  expect([empty.shown('model'), empty.shown('effort'), empty.source('effort')]).toEqual([
    'opus',
    'high',
    'applied'
  ])
  // A toggle is never filled on the phone; the desktop seed keeps the decoded boolean.
  expect(empty.source('fastMode')).toBe('unknown')
  seedNativeChatAppliedSessionOptions('applied-options-desktop', 'claude', applied)
  expect(chip('applied-options-desktop').shown('fastMode')).toBe(true)

  const picked = chip('applied-options-pick')
  await picked.surface.setOption('effort', 'low')
  picked.surface.fillAppliedSessionOptions(applied)
  expect([picked.shown('effort'), picked.source('effort')]).toEqual(['low', 'dispatched'])

  const reported = chip('applied-options-reported')
  reported.report('opus')
  reported.surface.fillAppliedSessionOptions({ effort: 'high' })
  expect([reported.shown('effort'), reported.source('effort')]).toEqual(['high', 'applied'])
})

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
