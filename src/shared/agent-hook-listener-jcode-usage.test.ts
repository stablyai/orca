import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { prepareJcodeRootSettlement } from './agent-hook-listener'
import { normalizeAndAccept, PANE_KEY } from './agent-hook-listener-test-harness'
import {
  createHookListenerState,
  type HookListenerState
} from './agent-hook-listener/listener-state'
import { tigressHooks, workerMetadata } from './agent-hook-listener-jcode-swarm-fixtures'
import {
  skunkHooks,
  skunkId,
  skunkMetadata,
  usageA,
  usageB
} from './agent-hook-listener-jcode-usage-fixtures'

describe('Jcode root last-turn usage', () => {
  let home: string
  let state: HookListenerState
  const accept = (payload: Record<string, unknown>) => normalizeAndAccept(state, 'jcode', payload)

  function completeTurnA() {
    accept(skunkHooks.sessionStart)
    accept(skunkHooks.turnStartA)
    accept(skunkHooks.postToolWrite)
    return accept(skunkHooks.turnEndA)
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    home = mkdtempSync(join(tmpdir(), 'orca-jcode-usage-'))
    mkdirSync(join(home, 'sessions'))
    vi.stubEnv('JCODE_HOME', home)
    state = createHookListenerState()
    writeFileSync(join(home, 'sessions', `${skunkId}.json`), JSON.stringify(skunkMetadata))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
    rmSync(home, { recursive: true, force: true })
  })

  it('sets last-turn usage from the captured turn_end payload', () => {
    accept(skunkHooks.sessionStart)
    expect(accept(skunkHooks.turnStartA)?.payload).not.toHaveProperty('lastTurnUsage')
    accept(skunkHooks.postToolWrite)
    const ended = accept(skunkHooks.turnEndA)
    expect(ended?.payload.lastTurnUsage).toEqual(usageA)
  })

  it('carries usage into the next turn, then replaces it', () => {
    completeTurnA()
    expect(accept(skunkHooks.turnStartB)?.payload.lastTurnUsage).toEqual(usageA)
    expect(accept(skunkHooks.postToolEdit)?.payload.lastTurnUsage).toEqual(usageA)
    expect(accept(skunkHooks.turnEndB)?.payload.lastTurnUsage).toEqual(usageB)
  })

  // Negative controls: captured input count as a JSON number and a padded string.
  it.each([616, ' 616 '])('accepts input tokens as %j', (inputTokens) => {
    accept(skunkHooks.sessionStart)
    accept(skunkHooks.turnStartA)
    const ended = accept({ ...skunkHooks.turnEndA, input_tokens: inputTokens })
    expect(ended?.payload.lastTurnUsage).toEqual(usageA)
  })

  it.each([true, false])(
    'applies a late turn end after cancel settlement (tokens: %s)',
    (withTokens) => {
      completeTurnA()
      accept(skunkHooks.turnStartB)
      const turn = state.jcodeTurnByPaneKey.get(PANE_KEY)
      if (!turn) {
        throw new Error('Root turn missing')
      }
      const settlement = prepareJcodeRootSettlement(state, PANE_KEY, skunkId, turn.revision)
      expect(settlement?.payload.lastTurnUsage).toEqual(usageA)
      settlement?.commit()
      // Negative control: late captured turn B, with or without its token fields.
      const payload = Object.fromEntries(
        Object.entries(skunkHooks.turnEndB).filter(
          ([key]) => withTokens || !key.endsWith('_tokens')
        )
      )
      const ended = accept(payload)
      expect(ended?.payload.state).toBe('done')
      if (withTokens) {
        expect(ended?.payload.lastTurnUsage).toEqual(usageB)
      } else {
        expect(ended?.payload).not.toHaveProperty('lastTurnUsage')
      }
    }
  )

  // Negative controls: captured turn A with malformed or missing required token fields.
  it.each(['NaN', '-5', '1e3', '', 'missing-output', 'missing-both'])(
    'clears usage on a turn_end without usable counts: %s',
    (variant) => {
      completeTurnA()
      accept(skunkHooks.turnStartB)
      const payload: Record<string, unknown> = { ...skunkHooks.turnEndA }
      if (variant === 'missing-output' || variant === 'missing-both') {
        delete payload.output_tokens
        if (variant === 'missing-both') {
          delete payload.input_tokens
        }
      } else {
        payload.input_tokens = variant
      }
      const ended = accept(payload)
      expect(ended?.payload.state).toBe('done')
      expect(ended?.payload).not.toHaveProperty('lastTurnUsage')
    }
  )

  it('keeps usage on a same-session session_start', () => {
    const first = accept(skunkHooks.sessionStart)
    expect(first?.providerSessionOnly).toBe(true)
    expect(first?.payload).not.toHaveProperty('lastTurnUsage')
    completeTurnA()
    const reattached = accept(skunkHooks.sessionStart)
    expect(reattached?.providerSessionOnly).toBe(true)
    expect(reattached?.payload.lastTurnUsage).toEqual(usageA)
    expect(accept(skunkHooks.turnStartB)?.payload.lastTurnUsage).toEqual(usageA)
  })

  it('ignores a duplicate tokenless turn_end and keeps usage', () => {
    completeTurnA()
    accept(skunkHooks.turnStartB)
    expect(accept(skunkHooks.turnEndB)?.payload.lastTurnUsage).toEqual(usageB)
    // Negative control: duplicate captured turn B with every token field removed.
    const tokenless: Record<string, unknown> = { ...skunkHooks.turnEndB }
    for (const key of Object.keys(tokenless)) {
      if (key.endsWith('_tokens')) {
        delete tokenless[key]
      }
    }
    expect(accept(tokenless)).toBeNull()
    expect(accept(skunkHooks.turnStartC)?.payload.lastTurnUsage).toEqual(usageB)
  })

  it('drops a bad optional field alone', () => {
    accept(skunkHooks.sessionStart)
    accept(skunkHooks.turnStartA)
    // Negative control: malformed cache count in captured turn A.
    const ended = accept({ ...skunkHooks.turnEndA, cache_read_tokens: 'x' })
    expect(ended?.payload.lastTurnUsage).toEqual({
      inputTokens: 616,
      outputTokens: 138,
      cacheWriteTokens: 589,
      durationMs: 12632
    })
  })

  it('never applies worker turn_end usage to the root', () => {
    completeTurnA()
    // Negative control: captured worker re-parented to the Skunk root.
    writeFileSync(
      join(home, 'sessions', `${workerMetadata.id}.json`),
      JSON.stringify({ ...workerMetadata, parent_id: skunkId })
    )
    for (const hook of [tigressHooks[2], tigressHooks[4], tigressHooks[5]]) {
      const event = accept(hook)
      expect(event?.payload.lastTurnUsage).toEqual(usageA)
      expect(event?.payload.lastTurnUsage).not.toMatchObject({
        inputTokens: 588,
        outputTokens: 486
      })
    }
  })

  it('keeps the last completed turn usage after cancel settlement', () => {
    completeTurnA()
    accept(skunkHooks.turnStartB)
    const turn = state.jcodeTurnByPaneKey.get(PANE_KEY)
    if (!turn) {
      throw new Error('Root turn missing')
    }
    const settlement = prepareJcodeRootSettlement(state, PANE_KEY, skunkId, turn.revision)
    expect(settlement?.payload.state).toBe('done')
    expect(settlement?.payload.lastTurnUsage).toEqual(usageA)
    settlement?.commit()
    expect(state.jcodeRootPayloadByPaneKey.get(PANE_KEY)?.lastTurnUsage).toEqual(usageA)
  })
})
