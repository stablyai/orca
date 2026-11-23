import { expect, it } from 'vitest'
import {
  automationWithFullAccess,
  automationChatPermissionMode
} from './automation-permission-policy'
import { automationLaunchInputs } from './automation-launch-choices'
import { automationCanonicalLaunchSetup } from './automation-canonical-launch-setup'

it('overrides inherited and legacy permissions only for an opted-in automation launch', () => {
  const saved = {
    agentId: 'codex' as const,
    prompt: 'Only report the current directory',
    rrule: 'FREQ=DAILY;BYHOUR=7',
    enabled: false,
    launchSetup: { agentArgs: '-a on-request -s read-only --model example-model' }
  }
  const before = structuredClone(saved)
  expect(automationWithFullAccess(saved, false)).toBe(saved)
  const launch = automationWithFullAccess(saved, true)
  const projected = automationLaunchInputs('codex', automationCanonicalLaunchSetup(launch))
  expect(projected.chatSessionOptions?.permissionMode).toBe('full-access')
  expect(projected.sessionOptions?.permissionMode).toBe('full-access')
  expect(launch.prompt).toBe('Only report the current directory')
  expect(launch.rrule).toBe('FREQ=DAILY;BYHOUR=7')
  expect(launch.enabled).toBe(false)
  expect(saved).toEqual(before)
  expect(automationChatPermissionMode('codex', { automationFullAccess: true }, true, 'ask')).toBe(
    'full-access'
  )
  expect(
    automationChatPermissionMode('codex', { automationFullAccess: true }, undefined, 'ask')
  ).toBe('ask')
  expect(
    automationChatPermissionMode('codex', { automationFullAccess: true }, undefined, undefined)
  ).toBeNull()
  expect(automationChatPermissionMode('codex', {}, true, undefined)).toBeNull()
  const scoped = { fullAccessBotIds: ['selected-bot'] }
  expect(automationChatPermissionMode('codex', scoped, false, 'ask', 'selected-bot')).toBe(
    'full-access'
  )
  expect(automationChatPermissionMode('claude', scoped, false, 'auto', 'selected-bot')).toBe(
    'full-access'
  )
  expect(automationChatPermissionMode('codex', scoped, false, 'ask', 'another-bot')).toBe('ask')
  expect(automationChatPermissionMode('codex', scoped, false, 'ask')).toBe('ask')
  expect(() =>
    automationChatPermissionMode('unknown', { automationFullAccess: true }, true, 'ask')
  ).toThrow('cannot start this automation with Full Access')
})
