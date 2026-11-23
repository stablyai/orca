import { expect, it, vi } from 'vitest'
import { getAgentSessionOptionCatalog } from '../../../agent-session/options/agent-session-option-catalog'
import { createNativeChatPtySessionOptions } from './native-chat-pty-session-options'
import { seedNativeChatLaunchSessionOptionsIfUnseen } from './native-chat-session-option-cache'
import {
  takeNativeChatStatusReport,
  type NativeChatStatusReportMemory
} from './native-chat-status-session-options'

const claude = getAgentSessionOptionCatalog('claude')!
const codex = getAgentSessionOptionCatalog('codex')!

function chip(scopeKey: string, dispatchCommand: () => Promise<void> = async () => {}) {
  const memory: NativeChatStatusReportMemory = new Map()
  const surface = createNativeChatPtySessionOptions({
    agent: 'claude',
    scopeKey,
    mode: 'live',
    modelLabel: 'Model',
    dispatchCommand
  })!
  const report = (model: string, effort: string, sessionId = 'session-a') => {
    const reported = takeNativeChatStatusReport(memory, scopeKey, 'claude', claude, claude.models, {
      model,
      providerSession: { id: sessionId, effort }
    })
    if (reported) {
      surface.reportSessionOptions(reported.values, reported.forNewModel)
    }
  }
  const shown = (id: string) => {
    const kind = surface.getSnapshot().find((row) => row.id === id)?.kind
    return kind?.type === 'select' ? kind.currentValue : undefined
  }
  return { surface, report, shown }
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

function seededChip(agent: 'claude' | 'codex', scopeKey: string) {
  const catalog = agent === 'claude' ? claude : codex
  const memory: NativeChatStatusReportMemory = new Map()
  const surface = createNativeChatPtySessionOptions({
    agent,
    scopeKey,
    mode: 'live',
    modelLabel: 'Model',
    dispatchCommand: async () => {}
  })!
  const report = (model: string, effort?: string) => {
    const reported = takeNativeChatStatusReport(memory, scopeKey, agent, catalog, catalog.models, {
      model,
      ...(effort ? { providerSession: { id: 'session-a', effort } } : {})
    })
    if (reported) {
      surface.reportSessionOptions(reported.values, reported.forNewModel)
    }
  }
  const effort = () => {
    const row = surface.getSnapshot().find((option) => option.id === 'effort')
    return [row?.kind.type === 'select' ? row.kind.currentValue : undefined, row?.valueSource]
  }
  return { report, effort }
}

it('shows the launch effort until a live report or a later launch seed says otherwise', () => {
  const scopeKey = 'launch-seed-codex'
  const model = codex.models[0].id
  seedNativeChatLaunchSessionOptionsIfUnseen(scopeKey, 'codex', { model, effort: 'high' })
  const { report, effort } = seededChip('codex', scopeKey)
  expect(effort()).toEqual(['high', 'applied'])
  report(model)
  expect(effort()).toEqual(['high', 'applied'])
  seedNativeChatLaunchSessionOptionsIfUnseen(scopeKey, 'codex', { model, effort: 'low' })
  expect(seededChip('codex', scopeKey).effort()).toEqual(['high', 'applied'])
})

it('lets a reported Claude effort replace the launch effort', () => {
  const scopeKey = 'launch-seed-claude'
  seedNativeChatLaunchSessionOptionsIfUnseen(scopeKey, 'claude', {
    model: 'opus',
    effort: 'high'
  })
  const { report, effort } = seededChip('claude', scopeKey)
  expect(effort()).toEqual(['high', 'applied'])
  report('claude-opus-5-5', 'low')
  expect(effort()[0]).toBe('low')
})
