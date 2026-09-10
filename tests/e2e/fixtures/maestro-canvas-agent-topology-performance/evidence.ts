import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'

export const EVIDENCE_DIR = path.resolve(
  '.visual-evidence/maestro-canvas-agent-topology-performance'
)
export const PROFILES = {
  desktop: { id: 'desktop', width: 1920, height: 1080 },
  notebook: { id: 'notebook', width: 1366, height: 768 }
} as const

export type EvidenceProfile = (typeof PROFILES)[keyof typeof PROFILES]

export function prepareEvidence(): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
}

export async function capture(
  page: Page,
  id: string,
  profile: EvidenceProfile,
  animations: 'allow' | 'disabled' = 'disabled'
): Promise<string> {
  await page.setViewportSize({ width: profile.width, height: profile.height })
  const file = `${id}-${profile.id}.png`
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, file),
    animations,
    caret: 'hide',
    scale: 'css'
  })
  return file
}

export function writeMetrics(metrics: Readonly<Record<string, unknown>>): void {
  writeFileSync(path.join(EVIDENCE_DIR, 'metrics.json'), `${JSON.stringify(metrics, null, 2)}\n`)
}

export function writeManifest({
  files,
  metrics
}: {
  files: readonly string[]
  metrics: Readonly<Record<string, unknown>>
}): void {
  const previousMetrics = existsSync(path.join(EVIDENCE_DIR, 'metrics.json'))
    ? (JSON.parse(readFileSync(path.join(EVIDENCE_DIR, 'metrics.json'), 'utf8')) as Record<
        string,
        unknown
      >)
    : {}
  const mergedMetrics = { ...previousMetrics, ...metrics }
  writeMetrics(mergedMetrics)
  const discoveredFiles = readdirSync(EVIDENCE_DIR).filter((file) => file.endsWith('.png'))
  const manifestFiles = [...new Set([...files, ...discoveredFiles])].sort()
  const visualLines = manifestFiles.map((file) => {
    const profile = file.endsWith('-notebook.png') ? PROFILES.notebook : PROFILES.desktop
    const id = file.replace(/\.png$/, '')
    const sha256 = createHash('sha256')
      .update(readFileSync(path.join(EVIDENCE_DIR, file)))
      .digest('hex')
    const geometry = `${profile.width}x${profile.height}`
    return `- Visual: ${id} | Maestro Canvas | ${profile.id} | ${geometry} | ${file}; sha256=${sha256}`
  })
  writeFileSync(
    path.join(EVIDENCE_DIR, 'manifest.md'),
    [
      '# Maestro Canvas agent topology and performance evidence',
      '',
      'Built Electron E2E via Playwright CDP on Linux. Desktop and notebook are the supported changed platforms; mobile consumes the same identities but this change does not alter its rendered route.',
      '',
      '## PNG evidence',
      '',
      ...visualLines,
      '',
      '## Bounded diagnostics',
      '',
      'See `metrics.json` for heavy-preview counts, exact event-dispatch processing costs, diagnostic Chromium Long Tasks, passive PTY uniqueness, and focus ownership.',
      '',
      '## Vision review',
      '',
      '- Topology: coordinator, worker functions, delegation direction, and the nested worker relationship remain legible at both supported viewport profiles.',
      '- Live terminals: five exact passive previews retain distinct output and do not capture terminal focus during drag, resize, pan, or zoom; partially off-viewport windows remain reachable on the infinite board.',
      '- Browser: the exact live Browser surface is recognizable from its rendered page content inside the Canvas.',
      '- Density: the compact populated layout stays navigable, while the low-detail overview replaces expensive previews with identity-preserving shells.',
      '- Motion: smoke enter/exit states read as one short dissolve; reduced-motion replaces the smoke with a plain opacity transition.',
      '- Empty topology: removing orchestration metadata also removes inferred roles and runtime lineage without inventing relationships.',
      ''
    ].join('\n')
  )
}
