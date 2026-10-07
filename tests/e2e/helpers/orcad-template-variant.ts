/**
 * A second orcad template that differs from the first only in its build identity, so a relaunch
 * with it stands in for an app update that bundles a newer orcad.
 */
import { createHash } from 'node:crypto'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  ORCAD_TEMPLATE_MANIFEST_FILENAME,
  ORCAD_VERSION
} from '../../../src/shared/orcad-artifacts'

const ENTRY = 'orcad.js'

/** Rewrites `templateDir` in place; its manifest keeps verifying. */
export function makeOrcadTemplateVariant(templateDir: string, tag: string): void {
  const entry = path.join(templateDir, ENTRY)
  appendFileSync(entry, `\n// orcad e2e template variant ${tag}\n`)
  const manifestPath = path.join(templateDir, ORCAD_TEMPLATE_MANIFEST_FILENAME)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.commonSha256[ENTRY] = createHash('sha256').update(readFileSync(entry)).digest('hex')
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
}

/** The host's activation record, read the way a client reads it. */
export function readHostOrcadActivation(exec: (command: string) => string): {
  active?: string
  previous?: string
  activeAppVersion?: string
} {
  return JSON.parse(exec('cat "$HOME/.orca-remote/orcad-active.json"'))
}

export function isOrcadFullVersion(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(`${ORCAD_VERSION}+`)
}
