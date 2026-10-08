import { describe, expect, it } from 'vitest'
import { escapeP4FileArg } from './p4-command'
import { buildChangeSpec } from './perforce-changelists'
import { parseOpenedEntries, parseReconcilePreview } from './perforce-status'

describe('parseOpenedEntries', () => {
  it('maps fstat records to workspace-relative entries', () => {
    const out = [
      '... depotFile //depot/a.txt',
      '... clientFile /ws/src/a.txt',
      '... action edit',
      '... change default',
      '... type text',
      '',
      '... depotFile //depot/b.txt',
      '... clientFile /ws/b.txt',
      '... action add',
      '... change 42',
      ''
    ].join('\n')
    expect(parseOpenedEntries('/ws', out)).toEqual([
      {
        path: 'src/a.txt',
        depotPath: '//depot/a.txt',
        action: 'edit',
        group: 'opened',
        changelist: 'default',
        fileType: 'text'
      },
      {
        path: 'b.txt',
        depotPath: '//depot/b.txt',
        action: 'add',
        group: 'opened',
        changelist: 42,
        fileType: undefined
      }
    ])
  })

  it('skips files outside the workspace directory', () => {
    const out = '... clientFile /elsewhere/x.txt\n... action edit\n'
    expect(parseOpenedEntries('/ws', out)).toEqual([])
  })
})

describe('parseReconcilePreview', () => {
  it('groups adds as new and edits/deletes as modified', () => {
    const out = [
      '... clientFile /ws/new.txt',
      '... action add',
      '',
      '... clientFile /ws/old.txt',
      '... action edit',
      '',
      '... clientFile /ws/gone.txt',
      '... action delete',
      ''
    ].join('\n')
    expect(parseReconcilePreview('/ws', out).map((e) => [e.path, e.group])).toEqual([
      ['new.txt', 'new'],
      ['old.txt', 'modified'],
      ['gone.txt', 'modified']
    ])
  })

  // `p4 -ztag reconcile -n -a <file>` from a real P4D 2026.1 server, with the depot and local
  // paths renamed. Tagged output names the local file in clientFile; untagged output is depot syntax.
  it('reads a real server transcript, with and without -l', () => {
    const tagged = [
      '... depotFile //depot/main/probe.txt',
      '... clientFile /ws/probe.txt',
      '... workRev 1',
      '... action add',
      '... type text',
      ''
    ]
    const withLocalSyntax = [
      ...tagged.slice(0, 2),
      '... localFile /ws/probe.txt',
      ...tagged.slice(2)
    ]
    for (const out of [tagged, withLocalSyntax]) {
      expect(parseReconcilePreview('/ws', out.join('\n'))).toEqual([
        {
          path: 'probe.txt',
          depotPath: '//depot/main/probe.txt',
          action: 'add',
          group: 'new',
          fileType: 'text'
        }
      ])
    }
  })
})

describe('escapeP4FileArg', () => {
  it('escapes wildcard and revision characters', () => {
    expect(escapeP4FileArg('a@b#c*d%e.txt')).toBe('a%40b%23c%2Ad%25e.txt')
  })
})

describe('buildChangeSpec', () => {
  it('replaces the description and drops the file list', () => {
    const template = [
      'Change:\tnew',
      '',
      'Client:\tws',
      '',
      'Description:',
      '\t<enter description here>',
      '',
      'Files:',
      '\t//depot/a.txt\t# edit',
      ''
    ].join('\n')
    const spec = buildChangeSpec(template, 'Fix bug\nmore detail')
    expect(spec).toContain('Description:\n\tFix bug\n\tmore detail')
    expect(spec).not.toContain('Files:')
    expect(spec).not.toContain('enter description')
    expect(spec).toContain('Client:\tws')
  })
})
