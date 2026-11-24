import { expect, it } from 'vitest'
import { svgPathDataIssue } from './plugin-panel-path-data'

it('accepts legal compact path syntax', () => {
  for (const data of [
    'M4 4h16v16H4z',
    'M0 0l1-1',
    'M.5.5l.5.5',
    'M1e-3 2E+2L3e3,4',
    'M1 2L-.5-1.5',
    'M0 0L1e38 1e-99999',
    'M0 0L3.4e38-3.4e38L1e+38 0',
    'M0,0 1,1 2,2',
    'm0 0 1 1zM2 2 3 3Z',
    'M0 0\tL1\n1\rL2\f2 ',
    'M0 0C1 1 2 2 3 3S4 4 5 5Q6 6 7 7T8 8',
    'M2 2a1 1 0 00 1 1',
    'M2 2A1,1,0,1,1,3,3a1 1 0 1 0 4 4',
    'M2 2a1 1 0 0 1-1-1'
  ]) {
    expect(svgPathDataIssue(data), data).toBeNull()
  }
})

it('refuses data that does not start with a moveto', () => {
  expect(svgPathDataIssue('L0 0')).toBe('must start with M or m')
  expect(svgPathDataIssue(' M0 0')).toBe('must start with M or m')
})

it('refuses commands with the wrong number of arguments', () => {
  for (const data of [
    'M',
    'M0',
    'M0 0L1',
    'M0 0 1',
    'M0 0C1 1 2 2 3',
    'M0 0H',
    'M0 0A1 1 0 0 1 2'
  ]) {
    expect(svgPathDataIssue(data), data).toMatch(/needs \d numbers per segment/)
  }
  expect(svgPathDataIssue('M0 0z1 1')).toMatch(/expected a path command/)
})

it('refuses arc flags that are not 0 or 1', () => {
  expect(svgPathDataIssue('M0 0a1 1 0 2 1 2 2')).toMatch(/arc flag at position 12/)
  expect(svgPathDataIssue('M0 0a1 1 0 0 .5 2 2')).toMatch(/arc flag/)
})

it('refuses malformed numbers and separators', () => {
  for (const data of ['M0 0L1e 1', 'M0 0L- 1', 'M0 0L. 1', 'M,0 0', 'M0,,0', 'M0 0L1--1']) {
    expect(svgPathDataIssue(data), data).not.toBeNull()
  }
  expect(svgPathDataIssue('M0 0,')).toMatch(/comma at position 5 with no number/)
  expect(svgPathDataIssue('M0 0,z')).toMatch(/comma/)
})

it('refuses whitespace that SVG does not allow', () => {
  for (const space of ['\u00a0', '\u2028', '\u3000', '\v', '\ufeff']) {
    expect(svgPathDataIssue(`M0${space}0`), JSON.stringify(space)).not.toBeNull()
    expect(svgPathDataIssue(`M0 0${space}`), JSON.stringify(space)).not.toBeNull()
  }
})

it('refuses numbers that end with a dot, which Chromium does not draw', () => {
  for (const data of ['M1. 2.L-.5-1.5', 'M0 0L1 2.', 'M0 0L1.e2 1', 'M0 0L1..5 1']) {
    expect(svgPathDataIssue(data), data).toMatch(/number at position \d+ that ends with a dot/)
  }
  expect(svgPathDataIssue('M1. 2')).toMatch(/position 2 /)
})

it('refuses numbers past the 32-bit float range, which cut the path short in Chromium', () => {
  for (const data of [
    'M0 0L1e39 1',
    'M0 0L1 1e+39',
    'M0 0L0.001e39 1',
    'M0 0L5e0039 1',
    'M0 0L3.5e38 1',
    'M0 0L-3.5e38 1',
    `M0 0L1${'0'.repeat(39)}e-10 1`,
    `M0 0L1e${'9'.repeat(400)} 1`
  ]) {
    expect(svgPathDataIssue(data), data).toMatch(/number at position \d+ that is too large to draw/)
  }
  expect(svgPathDataIssue(`M0 0L1${'0'.repeat(37)}e-10 1`)).toBeNull()
})

it('refuses an integer part near the float limit, even when the exponent scales it down', () => {
  // The number from the review: about 3.4 is written with a 39-digit integer part.
  const cut = 'M2 2H340282350000000000000000000000000000000e-38M8 8h8'
  expect(svgPathDataIssue(cut)).toMatch(/number at position 6 that is too large to draw/)
  expect(svgPathDataIssue(`M0 0L${'0'.repeat(3)}${'1'.repeat(39)}e-38 1`)).toMatch(/too large/)
  expect(svgPathDataIssue(`M0 0L1${'0'.repeat(38)}e-10 1`)).toMatch(/too large/)
  // Values at or above FLT_MAX are refused even when rounding would bring them back to it.
  expect(svgPathDataIssue('M0 0L3.4028235e38 1')).toMatch(/too large/)
  expect(svgPathDataIssue('M0 0L-3.4028235e38 1')).toMatch(/too large/)
})

it('counts leading zeros toward the integer digit limit, so padding cannot bypass it', () => {
  // 39 written digits, all but the last zero: the value is 1, but the spelling is past the limit.
  expect(svgPathDataIssue(`M0 0L${'0'.repeat(38)}1 1`)).toMatch(/too large/)
  expect(svgPathDataIssue(`M0 0L${'0'.repeat(38)}1e-10 1`)).toMatch(/too large/)
  expect(svgPathDataIssue(`M0 0L${'0'.repeat(39)}1e0 1`)).toMatch(/too large/)
  expect(svgPathDataIssue(`M0 0L-${'0'.repeat(38)}1 1`)).toMatch(/too large/)
  expect(svgPathDataIssue(`M0 0L${'0'.repeat(60)}.5 1`)).toMatch(/too large/)
  // 38 written digits, zeros included, is still within the limit.
  expect(svgPathDataIssue(`M0 0L${'0'.repeat(37)}1 1`)).toBeNull()
  expect(svgPathDataIssue(`M0 0L${'0'.repeat(30)}.5 1`)).toBeNull()
  // A padded spelling in a later segment is refused too, and names where it starts.
  expect(svgPathDataIssue(`M0 0L1 1L${'0'.repeat(38)}1 1`)).toMatch(/position 10 /)
})

it('keeps the rest of a path whose numbers are within range', () => {
  // A neighboring spelling of the same magnitude with a 38-digit integer part.
  expect(svgPathDataIssue('M2 2H34028235000000000000000000000000000000e-37M8 8h8')).toBeNull()
  expect(svgPathDataIssue('M2 2H34028235e30M8 8h8')).toBeNull()
})
