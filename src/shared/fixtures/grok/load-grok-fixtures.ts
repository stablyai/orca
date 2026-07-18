import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const FIXTURE_DIR = dirname(fileURLToPath(import.meta.url))

/** Read a fixture file next to this module (works under Vitest/Node ESM). */
export function readGrokFixtureText(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), 'utf8')
}

export function readGrokFixtureJson<T>(name: string): T {
  return JSON.parse(readGrokFixtureText(name)) as T
}

export function readGrokFixtureJsonl(name: string): string[] {
  return readGrokFixtureText(name)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}
