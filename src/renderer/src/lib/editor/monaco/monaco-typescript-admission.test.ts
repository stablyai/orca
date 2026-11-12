import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

type Definition = {
  uri: string
  range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }
}
type AdmissionResult = {
  modelCount: number
  diagnosticRequests: unknown[]
  useful: {
    language: string
    a: string
    b: string
    shared: Definition[]
    local: Definition[]
    edited: Definition[]
  }[]
  errors: string[]
  warnings: { phase: string; name: string; message: string; stack: string }[]
  markers: unknown[]
  retained: boolean
  sync: { kind: string; uri: string }[]
  currentVersions: { uri: string; version: number }[]
  mirrors: { uri: string; version: number }[]
  remainingModels: string[]
  remainingMirrors: unknown[]
}

const execute = promisify(execFile)
function definition(uri: string, line: number, endColumn: number): Definition[] {
  return [
    { uri, range: { startLineNumber: line, startColumn: 10, endLineNumber: line, endColumn } }
  ]
}

it.each([20, 200])(
  'does no disabled diagnostic admission for %i retained file pairs while TS/JS definitions follow edits',
  async (files) => {
    const directory = resolve(import.meta.dirname, 'monaco-typescript-admission.test-fixture')
    const { stdout } = await execute(
      'node',
      [
        '--import',
        resolve(directory, 'register.mjs'),
        resolve(directory, 'cold-case.mjs'),
        String(files)
      ],
      { cwd: process.cwd(), maxBuffer: 4 * 1024 * 1024 }
    ).catch((error: unknown) => {
      if (
        typeof error === 'object' &&
        error !== null &&
        'stdout' in error &&
        typeof error.stdout === 'string'
      ) {
        process.stderr.write(error.stdout)
      }
      throw error
    })
    const record = stdout.split('\n').find((line) => line.startsWith('ADMISSION_RESULT '))
    if (!record) {
      throw new Error('Native admission fixture produced no result')
    }
    const result: AdmissionResult = JSON.parse(record.slice('ADMISSION_RESULT '.length))
    if (result.warnings.length) {
      process.stderr.write(`ADMISSION_WARNINGS ${JSON.stringify(result.warnings)}\n`)
    }
    expect(result.errors).toEqual([])
    expect(result.diagnosticRequests).toEqual([])
    expect(result.modelCount).toBe(files * 2)
    expect(result.retained).toBe(true)
    expect(result.markers).toEqual([])
    expect(result.useful.map(({ language }) => language)).toEqual(['typescript', 'javascript'])
    for (const [index, useful] of result.useful.entries()) {
      expect(useful.shared).toEqual(definition(useful.a, 1, 17))
      expect(useful.local).toEqual(definition(useful.b, 2, 15))
      expect(useful.edited).toEqual(definition(useful.b, 2, 21))
      expect(result.sync.some(({ kind, uri }) => kind === 'change' && uri === useful.b)).toBe(true)
      expect(result.mirrors).toContainEqual(result.currentVersions[index])
    }
    expect(result.remainingModels).toEqual([])
    expect(result.remainingMirrors).toEqual([])
  },
  60_000
)
