// @vitest-environment happy-dom
import '../agent/launch-menu/new-tab-agent-menu-host-preferences-test-fixture'
import { act, renderHook } from '@testing-library/react'
import { expect, it } from 'vitest'

import { useBotAgentMenu } from './use-bot-agent-choices'

it("routes a paired-host bot's picker to that host", async () => {
  const hook = renderHook(() => useBotAgentMenu('runtime:alpha', true))
  await act(async () => {})

  const { model } = hook.result.current
  expect(model.state === 'settled' && model.pickerContext?.executionHostId).toBe('runtime:alpha')
})
