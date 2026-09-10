import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { expect, type Page } from '@stablyai/playwright-test'

export const CONTRACT_EVIDENCE_ROOT = path.resolve(
  '.visual-evidence/orchestration-maestro-contract-hardening'
)

export const DESKTOP_PROFILES = [
  { id: 'desktop', width: 1920, height: 1080 },
  { id: 'notebook', width: 1366, height: 768 }
] as const

export type DesktopProfile = (typeof DESKTOP_PROFILES)[number]

export async function setEvidenceViewport(page: Page, profile: DesktopProfile): Promise<void> {
  await page.setViewportSize({ width: profile.width, height: profile.height })
  await expect
    .poll(() => page.evaluate(() => ({ width: innerWidth, height: innerHeight })))
    .toEqual({ width: profile.width, height: profile.height })
}

export async function setEvidenceTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await page.evaluate((nextTheme) => {
    return window.__store?.getState().updateSettings({ theme: nextTheme })
  }, theme)
  await expect(page.locator('html')).toHaveClass(new RegExp(theme))
}

export async function captureDesktopEvidence(args: {
  page: Page
  id: string
  profile: DesktopProfile
}): Promise<void> {
  const directory = path.join(CONTRACT_EVIDENCE_ROOT, 'desktop')
  mkdirSync(directory, { recursive: true })
  await setEvidenceViewport(args.page, args.profile)
  await args.page.screenshot({
    path: path.join(directory, `${args.id}.png`),
    animations: 'disabled',
    caret: 'hide',
    scale: 'css'
  })
}
