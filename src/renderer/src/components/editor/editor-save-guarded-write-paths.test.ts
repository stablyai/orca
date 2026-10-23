import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const EDITOR_DIR = __dirname
const RAW_WRITE = /\b(?:writeRuntimeFile|fs\.writeFile)\s*\(/
const EDITOR_WRITE = /\bwriteEditorSave\s*\(/

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      return sourceFiles(path)
    }
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$|fixture/.test(name) ? [path] : []
  })
}

function filesMatching(dir: string, pattern: RegExp): string[] {
  return sourceFiles(dir)
    .filter((path) => pattern.test(readFileSync(path, 'utf8')))
    .map((path) => relative(EDITOR_DIR, path).split('\\').join('/'))
    .sort()
}

function functionBody(source: string, name: string): string {
  const body = source.slice(source.indexOf(`export function ${name}`))
  return body.slice(0, body.indexOf('\n}\n'))
}

describe('editor save paths', () => {
  it('make the raw file write only inside writeEditorSave', () => {
    expect(filesMatching(EDITOR_DIR, RAW_WRITE)).toEqual(['editor-save-disk-precondition.ts'])
    const source = readFileSync(join(EDITOR_DIR, 'editor-save-disk-precondition.ts'), 'utf8')
    expect(source.split('writeRuntimeFile(')).toHaveLength(2)
    const writer = functionBody(source, 'writeEditorSave')
    expect(writer).toContain('writeRuntimeFile(')
    // Only the explicit Overwrite reaches the writer without a precondition.
    expect(writer).toContain("write.kind === 'guarded'")
  })

  it('route every editor surface that saves a file through writeEditorSave', () => {
    expect(filesMatching(EDITOR_DIR, EDITOR_WRITE)).toEqual([
      'combined-diff/review-controls/use-combined-diff-section-actions.ts',
      'editor-save-disk-precondition.ts',
      'editor-save-queue.ts'
    ])
  })

  it('never turn a missing or disputed baseline into a write', () => {
    const source = readFileSync(join(EDITOR_DIR, 'editor-save-disk-precondition.ts'), 'utf8')
    const builder = functionBody(source, 'editorSavePrecondition')
    expect(builder).not.toMatch(/return null|return undefined/)
    expect(builder.match(/kind: 'explicit-overwrite'/g)).toHaveLength(1)
    expect(builder).toMatch(
      /if \(trigger === 'overwrite'\) \{\n\s*return \{ kind: 'explicit-overwrite' \}/
    )
    expect(builder).not.toContain('mode')
  })

  it('grant overwrite consent only from the conflict UI', () => {
    const grants = filesMatching(
      join(EDITOR_DIR, '..', '..'),
      /overwrite: true|\? 'overwrite'|, 'overwrite'\)/
    )
    expect(grants).toEqual([
      'DiffSectionItem.tsx',
      'ExternalFileChangeBanner.tsx',
      'editor-autosave-controller.ts'
    ])
  })
})
