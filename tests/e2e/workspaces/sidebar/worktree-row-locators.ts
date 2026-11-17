import type { Page } from '@stablyai/playwright-test'

function xpathLiteral(value: string): string {
  if (!value.includes("'")) {
    return `'${value}'`
  }
  if (!value.includes('"')) {
    return `"${value}"`
  }
  return `concat(${value
    .split("'")
    .map((part) => `'${part}'`)
    .join(`, '"'", `)})`
}

export function worktreeRow(page: Page, worktreeId: string) {
  return page.locator(`xpath=//*[@data-worktree-id=${xpathLiteral(worktreeId)}]`).first()
}

export function worktreeRowSurface(page: Page, worktreeId: string) {
  return worktreeRow(page, worktreeId).locator('[data-worktree-card-surface]').first()
}
