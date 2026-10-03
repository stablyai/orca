import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, it } from 'vitest'

/** Files that send without revealing the latest, each with its reason. */
const EXEMPT: Readonly<Record<string, string>> = {}

// A send path that skips `onSubmitted` leaves a scrolled-up reader looking at old output.
it('reveals the latest from every file that sends a native chat message', () => {
  const dir = import.meta.dirname
  const senders = readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name))
    // Comments dropped, so only a real call counts.
    .map((name) => ({
      name,
      source: readFileSync(path.join(dir, name), 'utf8').replace(/\/\/.*$/gm, '')
    }))
    .filter(({ source }) => source.includes('emitNativeChatMessageSent('))
  const silent = senders
    .filter(({ name, source }) => !(name in EXEMPT) && !/\bonSubmitted\?\.\(\)/.test(source))
    .map(({ name }) => name)

  // Anti-vacuous: the scan found the send sites.
  expect(senders.length).toBeGreaterThan(0)
  expect(silent).toEqual([])
})
