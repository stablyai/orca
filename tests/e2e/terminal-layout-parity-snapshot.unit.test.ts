import { describe, expect, it } from 'vitest'
import {
  compareParityCaptures,
  isParityClean,
  type DeclaredParityDifference,
  type RawParityCapture
} from './terminal-layout-parity-snapshot'

const ids = {
  a: {
    repo: '3e6c2c4c-adf9-4316-ba08-8c009886da6c',
    tab: 'ac89c78e-5baa-4c06-be9b-3594b95b8974',
    leafA: 'f79c6b84-37eb-491c-bb55-d238166cb478',
    leafB: '0faa8a32-15dc-432c-a682-10fe5f8cb29d',
    pty: '@@9bb36b1f',
    path: '/private/var/folders/x/T/orca-e2e-repo-AAAA',
    now: 1791231171039
  },
  b: {
    repo: 'daf8bee5-de36-4217-8eaf-f2cb5c684bcc',
    tab: '07413b91-7cb7-4925-8d48-99f125cdc8ad',
    leafA: 'e5bd116c-8cfb-4165-946a-bfab35aba500',
    leafB: '3ca564d4-1d13-4a96-91a2-6d523c0dbb4c',
    pty: '@@484c9b33',
    path: '/private/var/folders/x/T/orca-e2e-repo-BBBB',
    now: 1791231209172
  }
}

/** One split tab with every volatile value drawn from `run`, so two runs differ only in noise. */
function capture(run: (typeof ids)['a'], ratio = 0.5): RawParityCapture {
  const worktreeId = `${run.repo}::${run.path}`
  const layout = {
    root: {
      type: 'split',
      direction: 'vertical',
      ratio,
      first: { type: 'leaf', leafId: run.leafA },
      second: { type: 'leaf', leafId: run.leafB }
    },
    activeLeafId: run.leafB,
    // Id-keyed map whose raw key order disagrees between runs.
    ptyIdsByLeafId:
      run === ids.a
        ? { [run.leafA]: `${worktreeId}${run.pty}`, [run.leafB]: `${worktreeId}@@00000001` }
        : { [run.leafB]: `${worktreeId}@@00000002`, [run.leafA]: `${worktreeId}${run.pty}` },
    buffersByLeafId: { [run.leafA]: `prompt at ${run.now}` }
  }
  const session = {
    activeWorktreeId: worktreeId,
    tabsByWorktree: { [worktreeId]: [{ id: run.tab, createdAt: run.now, title: 'Terminal 1' }] },
    terminalLayoutsByTabId: { [run.tab]: layout },
    lastVisitedAtByWorktreeId: { [`local|${worktreeId}`]: run.now }
  }
  return {
    scenario: 'split',
    pathLabels: { [run.path]: '<repo>' },
    checkpoints: [{ label: 'after-quit', renderer: session, persisted: { local: session } }]
  }
}

const one = (value: RawParityCapture): Map<string, RawParityCapture> =>
  new Map([[value.scenario, value]])

describe('terminal layout parity', () => {
  it('treats two runs of one commit as equal despite ids, paths, times and key order', () => {
    const report = compareParityCaptures(one(capture(ids.a)), one(capture(ids.b)), [])
    expect(report.undeclared).toEqual([])
    expect(isParityClean(report)).toBe(true)
  })

  it('detects an injected layout difference and names where it is', () => {
    const report = compareParityCaptures(one(capture(ids.a)), one(capture(ids.b, 0.6)), [])
    expect(isParityClean(report)).toBe(false)
    expect(report.undeclared.map((difference) => difference.path)).toEqual([
      '[0].renderer.terminalLayoutsByTabId.#2.root.ratio',
      '[0].persisted.local.terminalLayoutsByTabId.#2.root.ratio'
    ])
  })

  it('treats an absent map and an empty one as equal', () => {
    const withEmpty = capture(ids.b)
    withEmpty.checkpoints[0]!.persisted = { local: { tombstones: {} } }
    const withoutMap = capture(ids.a)
    withoutMap.checkpoints[0]!.persisted = { local: {} }
    expect(compareParityCaptures(one(withoutMap), one(withEmpty), []).undeclared).toEqual([])
  })

  it('detects a scenario that only one side captured', () => {
    const report = compareParityCaptures(one(capture(ids.a)), new Map(), [])
    expect(report.undeclared).toMatchObject([{ scenario: 'split', head: '<missing>' }])
  })

  it('accepts a difference declared for its scenario and bug, and only there', () => {
    const declaration: DeclaredParityDifference = {
      scenario: 'split',
      bugId: 'STA-0000',
      paths: ['[0].renderer.terminalLayoutsByTabId', '[0].persisted.local.terminalLayoutsByTabId'],
      reason: 'test'
    }
    const report = compareParityCaptures(one(capture(ids.a)), one(capture(ids.b, 0.6)), [
      declaration
    ])
    expect(isParityClean(report)).toBe(true)
    expect(report.declared.map((difference) => difference.bugId)).toEqual(['STA-0000', 'STA-0000'])

    const elsewhere = compareParityCaptures(one(capture(ids.a)), one(capture(ids.b, 0.6)), [
      { ...declaration, scenario: 'other' }
    ])
    expect(elsewhere.undeclared).toHaveLength(2)
  })

  it('reports a path main does not reproduce without failing on it', () => {
    const report = compareParityCaptures(
      one(capture(ids.a)),
      one(capture(ids.b, 0.6)),
      [],
      [{ scenario: 'split', paths: ['[0].renderer', '[0].persisted'], evidence: 'test' }]
    )
    expect(isParityClean(report)).toBe(true)
    expect(report.unstableOnMain).toHaveLength(2)
  })

  it('fails a declared fix that changed nothing', () => {
    const report = compareParityCaptures(one(capture(ids.a)), one(capture(ids.b)), [
      { scenario: 'split', bugId: 'STA-0000', paths: ['[0]'], reason: 'test' }
    ])
    expect(isParityClean(report)).toBe(false)
    expect(report.unusedDeclarations).toHaveLength(1)
  })
})
