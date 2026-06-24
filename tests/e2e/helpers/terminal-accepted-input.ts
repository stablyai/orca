import type { Page } from '@stablyai/playwright-test'

export async function writePtyInputAccepted(
  page: Page,
  ptyId: string,
  text: string
): Promise<void> {
  const accepted = await page.evaluate(
    ({ ptyId, text }) => window.api.pty.writeAccepted?.(ptyId, text) ?? false,
    { ptyId, text }
  )
  if (!accepted) {
    throw new Error(`PTY input write was rejected for ${ptyId}`)
  }
}
