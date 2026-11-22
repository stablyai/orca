import { expect, it } from 'vitest'
import { svgPathDataIssue } from './plugin-panel-path-data'

it('accepts legal compact path syntax', () => {
  for (const data of [
    'M4 4h16v16H4z',
    'M0 0l1-1',
    'M.5.5l.5.5',
    'M1e-3 2E+2L3e3,4',
    'M1. 2.L-.5-1.5',
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
