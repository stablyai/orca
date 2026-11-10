// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest'
import {
  consumeNativeChatShellRuns,
  reanchorOrphanedNativeChatShellRuns,
  registerNativeChatShellHost,
  runNativeChatShellCommand,
  useNativeChatShellRuns
} from './native-chat-shell-runs'
import { renderHook } from '@testing-library/react'

const scope = 'shell-runs-test'

function currentRuns(): ReturnType<typeof useNativeChatShellRuns> {
  return renderHook(() => useNativeChatShellRuns((run) => run.scope === scope)).result.current
}

describe('reanchorOrphanedNativeChatShellRuns', () => {
  let unregister = (): void => {}

  afterEach(() => {
    consumeNativeChatShellRuns(currentRuns().map(({ id }) => id))
    unregister()
  })

  it('moves a card whose message left the transcript onto the latest one', () => {
    unregister = registerNativeChatShellHost(scope, {
      run: () => () => {},
      anchor: () => ({ id: 'before-clear', awaitingTurn: false })
    })
    runNativeChatShellCommand(scope, 'pwd')
    reanchorOrphanedNativeChatShellRuns(scope, [{ id: 'before-clear' }], 'before-clear')
    expect(currentRuns().map(({ anchorId }) => anchorId)).toEqual(['before-clear'])
    reanchorOrphanedNativeChatShellRuns(scope, [{ id: 'after-clear' }], 'after-clear')
    expect(currentRuns().map(({ anchorId }) => anchorId)).toEqual(['after-clear'])
  })
})

describe('registerNativeChatShellHost', () => {
  afterEach(() => {
    consumeNativeChatShellRuns(currentRuns().map(({ id }) => id))
  })

  it('keeps running through a view that stays open when a newer one closes', () => {
    const ran: string[] = []
    const host = (name: string) => ({
      run: () => {
        ran.push(name)
        return () => {}
      },
      anchor: () => ({ id: null, awaitingTurn: false })
    })
    const unregisterFirst = registerNativeChatShellHost(scope, host('first'))
    const unregisterSecond = registerNativeChatShellHost(scope, host('second'))
    unregisterSecond()
    runNativeChatShellCommand(scope, 'pwd')
    unregisterFirst()
    expect(ran).toEqual(['first'])
  })
})
