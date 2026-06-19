import { afterEach, describe, expect, it } from 'vitest'
import {
  beginTerminalContainerResizeSettle,
  isTerminalContainerResizeSettling,
  resetTerminalContainerResizeSettleForTests
} from './terminal-container-resize-settle'

describe('terminal container resize settle state', () => {
  afterEach(() => {
    resetTerminalContainerResizeSettleForTests()
  })

  it('stays active until every settle token releases', () => {
    const releaseA = beginTerminalContainerResizeSettle()
    const releaseB = beginTerminalContainerResizeSettle()

    expect(isTerminalContainerResizeSettling()).toBe(true)

    releaseA()
    expect(isTerminalContainerResizeSettling()).toBe(true)

    releaseB()
    expect(isTerminalContainerResizeSettling()).toBe(false)
  })

  it('ignores duplicate release calls', () => {
    const release = beginTerminalContainerResizeSettle()

    release()
    release()

    expect(isTerminalContainerResizeSettling()).toBe(false)
  })
})
