import { mkdirSync, writeFileSync } from 'node:fs'
import { prepareE2E } from '../../e2e/global-setup'
import {
  assertFrozenSource,
  buildInputsPath,
  evidenceDir,
  recordBuildInputs
} from './proof-build-inputs'

export default function setupAgentRowMenuProof(): void {
  console.log('Proof source', JSON.stringify(assertFrozenSource()))
  console.log('The IPC fixture supplies synthetic preparation and paired success.')
  prepareE2E({ electronSourceMaps: true })
  mkdirSync(evidenceDir, { recursive: true })
  writeFileSync(buildInputsPath, `${JSON.stringify(recordBuildInputs(), null, 2)}\n`)
  console.log(`Recorded build inputs before Electron launched: ${buildInputsPath}`)
}
