import { describe, expect, it } from 'vitest'
import { writeFileSync } from 'node:fs'
import { getRelativePathInsideRoot } from './path'
import { isPathInsideWorktree, toWorktreeRelativePath } from './terminal-links'
import { relativePathInsideRoot } from '../../../shared/cross-platform-path'

const nfc = '/Users/ada/내 드라이브/repo'
const nfd = nfc.normalize('NFD')

describe('probe', () => {
  it('reports current behavior', () => {
    const out = {
      libPath_NFDfile_NFCroot: getRelativePathInsideRoot(`${nfd}/docs/plan.md`, nfc),
      libPath_NFCfile_NFDroot: getRelativePathInsideRoot(`${nfc}/docs/plan.md`, nfd),
      terminalLinks_inside: isPathInsideWorktree(`${nfd}/docs/plan.md`, nfc),
      terminalLinks_rel: toWorktreeRelativePath(`${nfd}/docs/plan.md`, nfc),
      shared_NFDcand_NFCroot: relativePathInsideRoot(nfc, `${nfd}/docs/plan.md`),
      shared_NFCcand_NFDroot: relativePathInsideRoot(nfd, `${nfc}/docs/plan.md`),
      shared_sameform: relativePathInsideRoot(nfd, `${nfd}/docs/plan.md`)
    }
    writeFileSync('/tmp/nfc-probe-out.json', JSON.stringify(out, null, 2))
    expect(true).toBe(true)
  })
})
