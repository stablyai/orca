import { expect, it } from 'vitest'
import { shouldSuppressAlreadyDoneAgentProcessBoundary } from './already-done-process-boundary'

it('does not treat an already finished agent exit as a new completion', () => {
  expect(
    shouldSuppressAlreadyDoneAgentProcessBoundary({ state: 'done', agentType: 'pi' }, 'pi')
  ).toBe(true)
})

it('still reports a crash while the turn is in progress', () => {
  expect(
    shouldSuppressAlreadyDoneAgentProcessBoundary({ state: 'working', agentType: 'pi' }, 'pi')
  ).toBe(false)
})

it('does not suppress a different agent exit', () => {
  expect(
    shouldSuppressAlreadyDoneAgentProcessBoundary({ state: 'done', agentType: 'pi' }, 'codex')
  ).toBe(false)
})

it('does not suppress when the pane has no status row', () => {
  expect(shouldSuppressAlreadyDoneAgentProcessBoundary(undefined, 'pi')).toBe(false)
})
