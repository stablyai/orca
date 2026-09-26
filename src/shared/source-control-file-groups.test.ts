import { describe, expect, it } from 'vitest'
import { parseOrcaYaml } from './orca-yaml'
import { MAX_ORCA_YAML_COLLECTION_ENTRIES } from './orca-yaml-file-limit'
import { normalizeSourceControlFileGroups } from './source-control-file-groups'

describe('source control file groups in orca.yaml', () => {
  it('accepts a file containing only source-control presets', () => {
    expect(
      parseOrcaYaml(`sourceControl:
  fileGroups:
    - name: Snapshots
      patterns:
        - '**/__snapshots__/**'
        - '**/*.snap'
    - name: Generated code
      patterns:
        - '**/*.generated.ts'
        - '!src/keep.generated.ts'
`)
    ).toEqual({
      scripts: {},
      sourceControl: {
        fileGroups: [
          { name: 'Snapshots', patterns: ['**/__snapshots__/**', '**/*.snap'] },
          { name: 'Generated code', patterns: ['**/*.generated.ts', '!src/keep.generated.ts'] }
        ]
      }
    })
  })

  it('retains scripts and worktree defaults alongside file groups', () => {
    expect(
      parseOrcaYaml(`scripts:
  setup: pnpm install
worktree:
  sharedDirectories: [node_modules]
sourceControl:
  fileGroups:
    - name: Generated
      patterns: ['**/*.generated.ts']
`)
    ).toMatchObject({
      scripts: { setup: 'pnpm install' },
      worktree: { sharedDirectories: ['node_modules'] },
      sourceControl: { fileGroups: [{ name: 'Generated', patterns: ['**/*.generated.ts'] }] }
    })
  })

  it('ignores malformed and duplicate groups without changing meaningful pattern whitespace', () => {
    expect(
      normalizeSourceControlFileGroups([
        null,
        { name: 'Bad', patterns: [42] },
        { name: ' ', patterns: ['*.ts'] },
        { name: 'Empty', patterns: [] },
        { name: ' Generated ', patterns: ['\\#literal', 'name\\ '] },
        { name: 'Generated', patterns: ['*'] }
      ])
    ).toEqual([{ name: 'Generated', patterns: ['\\#literal', 'name\\ '] }])
  })

  it('bounds group and pattern counts before compiling repo-authored matchers', () => {
    expect(
      normalizeSourceControlFileGroups(
        Array.from({ length: MAX_ORCA_YAML_COLLECTION_ENTRIES + 1 }, () => ({
          name: 'Generated',
          patterns: ['*.ts']
        }))
      )
    ).toEqual([])
    expect(
      normalizeSourceControlFileGroups([
        { name: 'Generated', patterns: Array(MAX_ORCA_YAML_COLLECTION_ENTRIES + 1).fill('*.ts') }
      ])
    ).toEqual([])
  })
})
