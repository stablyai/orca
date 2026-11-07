import { describe, expect, it } from 'vitest'
import { mergeCapturedLeafState } from './merge-captured-leaf-state'

describe('mergeCapturedLeafState', () => {
  it('returns prior entries unchanged when fresh is empty (the wipe-protection case)', () => {
    const result = mergeCapturedLeafState({
      prior: { 'pane:1': 'old-buf-1', 'pane:2': 'old-buf-2' },
      fresh: {},
      currentLeafIds: new Set(['pane:1', 'pane:2'])
    })
    expect(result).toEqual({ 'pane:1': 'old-buf-1', 'pane:2': 'old-buf-2' })
  })

  it('overlays fresh entries on top of prior entries', () => {
    const result = mergeCapturedLeafState({
      prior: { 'pane:1': 'old-buf-1', 'pane:2': 'old-buf-2' },
      fresh: { 'pane:1': 'new-buf-1' },
      currentLeafIds: new Set(['pane:1', 'pane:2'])
    })
    expect(result).toEqual({ 'pane:1': 'new-buf-1', 'pane:2': 'old-buf-2' })
  })

  it('drops prior entries for leaves no longer present', () => {
    const result = mergeCapturedLeafState({
      prior: { 'pane:1': 'old-buf-1', 'pane:removed': 'gone' },
      fresh: { 'pane:1': 'new-buf-1' },
      currentLeafIds: new Set(['pane:1'])
    })
    expect(result).toEqual({ 'pane:1': 'new-buf-1' })
    expect(result).not.toHaveProperty('pane:removed')
  })

  it('returns empty when prior is undefined and fresh is empty', () => {
    const result = mergeCapturedLeafState({
      prior: undefined,
      fresh: {},
      currentLeafIds: new Set(['pane:1'])
    })
    expect(result).toEqual({})
  })

  it('returns fresh entries when prior is undefined', () => {
    const result = mergeCapturedLeafState({
      prior: undefined,
      fresh: { 'pane:1': 'fresh' },
      currentLeafIds: new Set(['pane:1'])
    })
    expect(result).toEqual({ 'pane:1': 'fresh' })
  })

  it('drops fresh entries for leaves outside currentLeafIds (defense in depth)', () => {
    const result = mergeCapturedLeafState({
      prior: {},
      fresh: { 'pane:1': 'fresh', 'pane:rogue': 'should-be-dropped' },
      currentLeafIds: new Set(['pane:1'])
    })
    expect(result).toEqual({ 'pane:1': 'fresh' })
    expect(result).not.toHaveProperty('pane:rogue')
  })
})
