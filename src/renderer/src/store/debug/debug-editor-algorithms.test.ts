import { ChangeSet, Text } from '@codemirror/state'
import { describe, expect, test } from 'vitest'
import {
  buildAttachLaunchConfig,
  buildAttachRows,
  formatAttachDetail,
  type DebugAttachableProcess
} from './debug-attach-processes'
import { calleeName, locateStepTargets, targetsOnLine } from './debug-smart-step-match'
import { identifiersIn, inlineValue, mapBreakpointsThroughChanges } from './debug-value-format'

describe('debug-smart-step-match', () => {
  test('maps 1-based DAP columns to 0-based UTF-16 ranges', () => {
    const line = 'const result = compute(a, parse(b))'
    const targets = [
      { id: 1, label: 'compute(a, parse(b))', line: 10, column: 16, endColumn: 23 },
      { id: 2, label: 'parse(b)', line: 10, column: 27, endColumn: 32 }
    ]
    const ranges = locateStepTargets(line, 10, targets)
    expect(ranges).toEqual([
      { id: 1, from: 15, to: 22 },
      { id: 2, from: 26, to: 31 }
    ])
  })

  test('falls back to callee boundaries when adapter omits line and column', () => {
    const line = 'foobar(bar(x))'
    const kept = targetsOnLine(line, 5, [
      { id: 1, label: 'obj.bar(x)' },
      { id: 2, label: 'missing()' }
    ])
    expect(kept.map((t) => t.id)).toEqual([1])
    expect(calleeName('a.b.parse(str(i))')).toBe('parse')

    const ranges = locateStepTargets('  foo(bar(x))', 5, [
      { id: 10, label: 'foo(bar(x))' },
      { id: 20, label: 'bar(x)' }
    ])
    expect(ranges).toEqual([
      { id: 10, from: 2, to: 5 },
      { id: 20, from: 6, to: 9 }
    ])
  })

  test('returns null when any target cannot be uniquely placed on the line', () => {
    const ranges = locateStepTargets('compute(1)', 3, [
      { id: 1, label: 'compute(1)' },
      { id: 2, label: 'notOnThisLine()' }
    ])
    expect(ranges).toBeNull()
  })
})

describe('debug-value-format', () => {
  test('extracts unique identifiers outside string literals and flattens values', () => {
    expect(identifiersIn('const label = "ignoredName"; return foo + bar(foo, baz)')).toEqual([
      'const',
      'label',
      'return',
      'foo',
      'bar',
      'baz'
    ])
    expect(inlineValue('line1\n  line2\n  line3', 10)).toBe('line1 lin…')
  })

  test('maps 1-based breakpoints through line insertions and deduplicating deletions', () => {
    const doc1 = Text.of(['first', 'second', 'third', 'fourth'])
    const initial = [
      { line: 2, enabled: true, condition: 'x > 0' },
      { line: 4, enabled: true }
    ]

    // Insert 2 lines at the start of line 1: shifts line 2 -> 4 and line 4 -> 6.
    const insertChanges = ChangeSet.of([{ from: 0, insert: 'a\nb\n' }], doc1.length)
    const doc2 = insertChanges.apply(doc1)
    expect(mapBreakpointsThroughChanges(initial, doc1, insertChanges, doc2)).toEqual([
      { line: 4, enabled: true, condition: 'x > 0' },
      { line: 6, enabled: true }
    ])

    // Merge lines 2..4 together: deduplicates onto line 2, keeping the first breakpoint.
    const mergeChanges = ChangeSet.of(
      [{ from: doc1.line(2).to, to: doc1.line(4).from, insert: ' ' }],
      doc1.length
    )
    const doc3 = mergeChanges.apply(doc1)
    expect(mapBreakpointsThroughChanges(initial, doc1, mergeChanges, doc3)).toEqual([
      { line: 2, enabled: true, condition: 'x > 0' }
    ])
  })
})

describe('debug-attach-processes', () => {
  const sample: DebugAttachableProcess[] = [
    {
      pid: 101,
      name: 'a.out',
      commandLine: './a.out',
      kind: 'native',
      adapter: 'codelldb'
    },
    {
      pid: 202,
      name: 'node.exe',
      commandLine: 'node.exe --inspect=9229 server.js',
      kind: 'node',
      adapter: 'js-debug',
      host: '127.0.0.1',
      port: 9229
    },
    {
      pid: 303,
      name: 'python.exe',
      commandLine: 'python.exe app.py',
      kind: 'python',
      adapter: 'debugpy'
    },
    {
      pid: 404,
      name: 'gosrv',
      commandLine: './gosrv --serve',
      kind: 'go',
      adapter: 'delve'
    }
  ]

  test('groups rows by kind order and applies multi-word filters', () => {
    const allRows = buildAttachRows(sample, '')
    expect(allRows.map((r) => r.key)).toEqual([
      'group:node',
      'node:202',
      'group:python',
      'python:303',
      'group:go',
      'go:404',
      'group:native',
      'native:101'
    ])
    const filtered = buildAttachRows(sample, 'node 9229')
    expect(filtered.map((r) => r.key)).toEqual(['group:node', 'node:202'])
    expect(formatAttachDetail(sample[1]!)).toBe('127.0.0.1:9229')
    expect(formatAttachDetail(sample[2]!)).toBe('pid 303')
  })

  test('builds per-adapter attach launch configurations', () => {
    const nodeCfg = buildAttachLaunchConfig(sample[1]!, 'D:/repo')
    expect(nodeCfg.adapter).toBe('js-debug')
    expect(JSON.parse(nodeCfg.extraJson!)).toEqual({
      type: 'pwa-node',
      address: '127.0.0.1',
      port: 9229,
      continueOnAttach: true
    })

    const pyListenCfg = buildAttachLaunchConfig({ ...sample[2]!, port: 5678 }, 'D:/repo')
    expect(JSON.parse(pyListenCfg.extraJson!)).toEqual({ debugServer: 5678 })

    const pyPidCfg = buildAttachLaunchConfig(sample[2]!, 'D:/repo')
    expect(JSON.parse(pyPidCfg.extraJson!)).toEqual({ processId: 303 })

    const goCfg = buildAttachLaunchConfig(sample[3]!, 'D:/repo')
    expect(goCfg.adapter).toBe('delve')
    expect(JSON.parse(goCfg.extraJson!)).toEqual({ mode: 'local', processId: 404 })

    const nativeCfg = buildAttachLaunchConfig(sample[0]!, 'D:/repo')
    expect(nativeCfg.adapter).toBe('codelldb')
    expect(JSON.parse(nativeCfg.extraJson!)).toEqual({ pid: 101 })
  })
})
