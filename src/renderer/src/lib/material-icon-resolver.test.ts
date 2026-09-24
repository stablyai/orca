import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  materialIconSvgFileName,
  resolveMaterialFileIconId,
  resolveMaterialFolderIconId,
  type MaterialIconManifest
} from './material-icon-resolver'

const require = createRequire(import.meta.url)
const manifestPath = require.resolve('material-icon-theme/dist/material-icons.json')
const iconsDir = path.join(path.dirname(manifestPath), '..', 'icons')
const realManifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as MaterialIconManifest

const fixture: MaterialIconManifest = {
  iconDefinitions: {
    file: { iconPath: './../icons/file.svg' },
    typescript: { iconPath: './../icons/typescript.svg' },
    test_ts: { iconPath: './../icons/test-ts.svg' },
    docker: { iconPath: './../icons/docker.svg' }
  },
  file: 'file',
  folder: 'folder',
  folderExpanded: 'folder-open',
  fileNames: { dockerfile: 'docker' },
  fileExtensions: { ts: 'typescript', 'test.ts': 'test_ts' },
  folderNames: { src: 'folder-src' },
  folderNamesExpanded: { src: 'folder-src-open' }
}

describe('resolveMaterialFileIconId', () => {
  it('matches exact file names case-insensitively before extensions', () => {
    expect(resolveMaterialFileIconId(fixture, 'Dockerfile')).toBe('docker')
  })

  it('prefers the longest matching extension', () => {
    expect(resolveMaterialFileIconId(fixture, 'app.test.ts')).toBe('test_ts')
    expect(resolveMaterialFileIconId(fixture, 'app.ts')).toBe('typescript')
  })

  it('uses only the base name of a path', () => {
    expect(resolveMaterialFileIconId(fixture, 'src/lib/app.ts')).toBe('typescript')
    expect(resolveMaterialFileIconId(fixture, 'C:\\repo\\Dockerfile')).toBe('docker')
  })

  it('falls back to the generic file icon', () => {
    expect(resolveMaterialFileIconId(fixture, 'notes.unknownext')).toBe('file')
    expect(resolveMaterialFileIconId(fixture, 'LICENSE')).toBe('file')
  })
})

describe('resolveMaterialFolderIconId', () => {
  it('uses named folder icons for open and closed states', () => {
    expect(resolveMaterialFolderIconId(fixture, 'src', false)).toBe('folder-src')
    expect(resolveMaterialFolderIconId(fixture, 'packages/SRC', true)).toBe('folder-src-open')
  })

  it('falls back to the generic folder icons', () => {
    expect(resolveMaterialFolderIconId(fixture, 'misc', false)).toBe('folder')
    expect(resolveMaterialFolderIconId(fixture, 'misc', true)).toBe('folder-open')
  })
})

describe('materialIconSvgFileName', () => {
  it('returns the svg file name for known ids and undefined otherwise', () => {
    expect(materialIconSvgFileName(fixture, 'typescript')).toBe('typescript.svg')
    expect(materialIconSvgFileName(fixture, 'missing')).toBeUndefined()
  })
})

describe('bundled material-icon-theme manifest', () => {
  it.each([
    ['Dockerfile', 'docker'],
    ['build.gradle', 'gradle'],
    ['README.md', 'readme'],
    ['index.tsx', 'react_ts'],
    ['Main.java', 'java']
  ])('resolves %s to %s', (name, iconId) => {
    expect(resolveMaterialFileIconId(realManifest, name)).toBe(iconId)
  })

  it('points every resolved icon at an svg that ships in the package', () => {
    const names = ['Dockerfile', 'index.tsx', 'Main.java', '.gitignore', 'unknown.zzz']
    for (const name of names) {
      const fileName = materialIconSvgFileName(
        realManifest,
        resolveMaterialFileIconId(realManifest, name)
      )
      expect(fileName && existsSync(path.join(iconsDir, fileName))).toBe(true)
    }
    for (const open of [false, true]) {
      const fileName = materialIconSvgFileName(
        realManifest,
        resolveMaterialFolderIconId(realManifest, 'src', open)
      )
      expect(fileName && existsSync(path.join(iconsDir, fileName))).toBe(true)
    }
  })
})
