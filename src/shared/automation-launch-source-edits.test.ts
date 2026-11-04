import { afterEach, describe, expect, it, vi } from 'vitest'
import * as source from './automation-launch-setup-source'
import { applyAutomationLaunchSetupPatch } from './automation-launch-setup'
import {
  encodeAutomationLaunchEdit,
  foldAutomationSourceEdit,
  type AutomationLaunchEdit
} from './automation-launch-source-edits'
import type { AutomationLaunchSetup } from './automations-types'

afterEach(() => vi.restoreAllMocks())

describe('automation source composition bounds', () => {
  it('keeps one source transform per accepted edit and no growing edit history', () => {
    const transform = vi.spyOn(source, 'patchAutomationArguments')
    const initial: AutomationLaunchSetup = {
      surface: 'terminal',
      launchPreferences: { model: 'sonnet' },
      agentArgs: '--saved-literal'
    }
    const receipts: string[] = []
    for (const count of [10, 100]) {
      transform.mockClear()
      let setup = initial
      let patch: AutomationLaunchEdit | undefined
      for (let index = 0; index < count; index++) {
        ;({ setup, patch } = foldAutomationSourceEdit('claude', setup, patch, {
          kind: 'arguments',
          value: { kind: 'value', value: index % 2 ? '--verbose' : '--model opus' }
        }))
      }
      expect(transform).toHaveBeenCalledTimes(count)
      const encoded = encodeAutomationLaunchEdit(patch ?? {}, 'terminal')
      receipts.push(JSON.stringify(encoded))
      expect(
        applyAutomationLaunchSetupPatch(
          { launchSetupPatch: encoded },
          { ...initial, agentId: 'claude' }
        )
      ).toMatchObject({ agentArgs: '--verbose', launchPreferences: setup.launchPreferences })
      expect(setup.launchPreferences?.model).toBeUndefined()
    }
    expect(receipts[1]).toBe(receipts[0])
  })
})
