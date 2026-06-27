import type { Buffer } from 'node:buffer'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { GraySlabAnalysis } from './terminal-raster-artifact-analysis'

const REPRO_ARTIFACT_DIR = path.join(process.cwd(), '.tmp', 'issue-5969-repro')

export function persistReproEvidence(
  label: string,
  analysis: GraySlabAnalysis,
  screenshot: Buffer
): void {
  mkdirSync(REPRO_ARTIFACT_DIR, { recursive: true })
  writeFileSync(path.join(REPRO_ARTIFACT_DIR, `${label}.png`), screenshot)
  writeFileSync(
    path.join(REPRO_ARTIFACT_DIR, `${label}.json`),
    `${JSON.stringify(analysis, null, 2)}\n`
  )
}
