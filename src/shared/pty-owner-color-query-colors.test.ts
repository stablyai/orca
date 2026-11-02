import { expect, it } from 'vitest'
import {
  ORCA_DEFAULT_COLOR_QUERY_REPLY_COLORS,
  normalizeColorQueryReplyColors,
  resolvePtyOwnerColorQueryColors
} from './pty-owner-color-query-colors'

it('prefers host colours, then spawn colours, then the default, skipping unusable pairs', () => {
  const host = { foreground: '#000000', background: '#111111' }
  const spawn = { foreground: '#222222', background: '#333333' }
  const unusable = { foreground: 'red', background: '#333333' }

  expect(resolvePtyOwnerColorQueryColors(host, spawn)).toEqual(host)
  expect(resolvePtyOwnerColorQueryColors(null, spawn)).toEqual(spawn)
  expect(resolvePtyOwnerColorQueryColors(unusable, spawn)).toEqual(spawn)
  expect(resolvePtyOwnerColorQueryColors(null, unusable)).toBe(
    ORCA_DEFAULT_COLOR_QUERY_REPLY_COLORS
  )
  expect(resolvePtyOwnerColorQueryColors(undefined, {})).toBe(ORCA_DEFAULT_COLOR_QUERY_REPLY_COLORS)
})

it('keeps only a wire pair that answers both slots', () => {
  expect(
    normalizeColorQueryReplyColors({ foreground: '#fff', background: 'rgb(1, 2, 3)' })
  ).toEqual({ foreground: '#fff', background: 'rgb(1, 2, 3)' })
  expect(normalizeColorQueryReplyColors({ foreground: '#fff' })).toBeNull()
  expect(normalizeColorQueryReplyColors({ foreground: '#fff', background: 'blue' })).toBeNull()
  expect(normalizeColorQueryReplyColors('#fff')).toBeNull()
  expect(normalizeColorQueryReplyColors(null)).toBeNull()
})

it("puts a launching client's colours ahead of the host's", () => {
  const launcher = { foreground: '#444444', background: '#555555' }
  const host = { foreground: '#000000', background: '#111111' }
  const spawn = { foreground: '#222222', background: '#333333' }

  expect(resolvePtyOwnerColorQueryColors(host, spawn, launcher)).toEqual(launcher)
  expect(
    resolvePtyOwnerColorQueryColors(host, spawn, { foreground: 'red', background: '#555555' })
  ).toEqual(host)
})
