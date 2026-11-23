import { expect, it } from 'vitest'
import { sanitizePaneKeyTimestampRecord } from './ui-slice-hydration-sanitizers'

it('counts a chat cutoff and its tab-keyed original as one clear against the limit', () => {
  const cutoffs: Record<string, number> = {}
  for (let at = 1; at <= 500; at++) {
    cutoffs[`structured-agent-session-s${at}:leaf-${at}`] = at
  }
  cutoffs['agent-chat-tab-v1-abc:leaf-1'] = 1
  expect(Object.keys(sanitizePaneKeyTimestampRecord(cutoffs))).toHaveLength(501)

  const kept = sanitizePaneKeyTimestampRecord({ ...cutoffs, 'terminal-t:leaf-0': 0.5 })
  expect(Object.keys(kept)).toHaveLength(501)
  expect(kept['terminal-t:leaf-0']).toBeUndefined()
})
