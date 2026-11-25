// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { expect, it } from 'vitest'
import type { BotAgent } from '../../../../shared/bot-types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host/execution-host'
import { suggestedBotAgent } from '../../../../shared/bots/hand-over-workspace'
import { useBotAgentSetup } from './use-bot-agent-setup'
import type { BotAgentMenu } from './use-bot-agent-choices'

const settled: Pick<BotAgentMenu, 'choices' | 'defaultAgent'> = {
  choices: ['claude', 'codex'],
  defaultAgent: 'codex'
}

it('preselects the host default agent unless an agent is handed in', () => {
  const preselected = renderHook(() => useBotAgentSetup(settled, LOCAL_EXECUTION_HOST_ID))
  expect(preselected.result.current.setup.agent).toBe('codex')
  const handed = renderHook(() => useBotAgentSetup(settled, LOCAL_EXECUTION_HOST_ID, 'claude'))
  expect(handed.result.current.setup.agent).toBe('claude')
  // Hand to bot from a workspace whose agents can't be bots keeps the host default.
  const handOver = renderHook(() =>
    useBotAgentSetup(settled, LOCAL_EXECUTION_HOST_ID, suggestedBotAgent(['aider']))
  )
  expect(handOver.result.current.setup.agent).toBe('codex')
})

it('does not change the selection after load when the default agent is ready', () => {
  const seen: BotAgent[] = []
  const loading: Pick<BotAgentMenu, 'choices' | 'defaultAgent'> = {
    choices: [],
    defaultAgent: 'codex'
  }
  const hook = renderHook(
    ({ menu }) => {
      const result = useBotAgentSetup(menu, LOCAL_EXECUTION_HOST_ID)
      seen.push(result.setup.agent)
      return result
    },
    { initialProps: { menu: loading } }
  )
  hook.rerender({ menu: settled })
  expect(new Set(seen)).toEqual(new Set(['codex']))
  const handed = renderHook(
    ({ menu }) => useBotAgentSetup(menu, LOCAL_EXECUTION_HOST_ID, 'claude'),
    {
      initialProps: { menu: loading }
    }
  )
  expect(handed.result.current.setup.agent).toBe('claude')
  handed.rerender({ menu: settled })
  expect(handed.result.current.setup.agent).toBe('claude')
})
