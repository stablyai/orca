import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

// Why: the envelope is one wire format, and every hand-rolled copy of it is a chance to
// disagree. Ten independent copies had already drifted — some kept a trailing `Error:` class
// name, some scoped themselves to a single channel, some rendered "Error" or an empty string
// when the envelope carried no reason, and one leaked the wrapper itself to 30 user-facing
// sites. This census is what stops an eleventh appearing.
const ENVELOPE_OWNERS = [
  // The canonical stripper. The only place the wire format is described.
  'src/shared/ipc-invoke-envelope.ts'
]

const REPO_ROOT = join(__dirname, '..', '..')

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      return listSourceFiles(fullPath)
    }
    if (!/\.(ts|tsx)$/.test(entry.name) || /\.test\.(ts|tsx)$/.test(entry.name)) {
      return []
    }
    return [fullPath]
  })
}

// Why: strip comments first, so a file that only *documents* the envelope (the terminal toast
// explains that its markers arrive IPC-wrapped) is not counted as a second implementation.
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

// Why: match the bare Electron names rather than a quoted-channel shape — the canonical file
// spells them as an alternation, and a future copy could too. Prose lives in comments, which
// are stripped above, so any surviving mention is code that knows the wire format.
const ENVELOPE_MATCHER = /Error invoking remote method|Error occurred in handler for/

describe('IPC invoke envelope has a single source of truth', () => {
  it('is described in exactly the files that own it', () => {
    const offenders = listSourceFiles(join(REPO_ROOT, 'src'))
      .filter((file) => ENVELOPE_MATCHER.test(stripComments(readFileSync(file, 'utf8'))))
      .map((file) => relative(REPO_ROOT, file).split(sep).join('/'))
      .sort()

    expect(offenders).toEqual([...ENVELOPE_OWNERS].sort())
  })
})
