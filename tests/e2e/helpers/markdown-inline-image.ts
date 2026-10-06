import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { expect } from '@stablyai/playwright-test'

const ERROR_BOUNDARY_TEXT = 'The rich markdown editor hit an unexpected error'
const SCHEMA_ERROR_SIGNATURE = 'Invalid content for node'

// A 22x22 PNG dot, small enough to keep inline with the surrounding text.
const INLINE_DOT_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAABYAAAAWCAYAAADEtGw7AAAAOklEQVR42mOoMGL4TwvMQHOD//dQB48aTKbB6IBigwmBwWUwsWDUYPINHnqpgqYZZLQQoqrBQ6bOAwDparQl4qEv0wAAAABJRU5ErkJggg=='

export const INLINE_IMAGE_FIXTURE_DIRECTORY = '.orca-e2e-markdown-inline-image'

export const INLINE_IMAGE_PARAGRAPH_MARKDOWN = [
  '# Inline image crash repro',
  '',
  'Some text ![alt](inline-dot.png) more text',
  ''
].join('\n')

export const INLINE_IMAGE_DETAILS_MARKDOWN = [
  '# Details summary inline image repro',
  '',
  '<details class="orca-details" open>',
  '<summary>Toggle ![alt](inline-dot.png) label</summary>',
  '',
  'Body',
  '',
  '</details>',
  ''
].join('\n')

export function writeInlineImageAsset(rootPath: string): void {
  const directory = path.join(rootPath, INLINE_IMAGE_FIXTURE_DIRECTORY)
  mkdirSync(directory, { recursive: true })
  writeFileSync(
    path.join(directory, 'inline-dot.png'),
    Buffer.from(INLINE_DOT_PNG_BASE64, 'base64')
  )
}

/**
 * The schema RangeError is thrown inside EditorView.dispatch, outside React's
 * render phase, so no error boundary observes it — it only surfaces as a page
 * error. Collect both signals.
 */
export function collectRichMarkdownPageErrors(page: Page): string[] {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(`${error.name}: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') {
      pageErrors.push(message.text())
    }
  })
  return pageErrors
}

export async function expectNoRichMarkdownSchemaCrash(
  page: Page,
  pageErrors: string[]
): Promise<void> {
  expect(
    pageErrors.filter((entry) => entry.includes(SCHEMA_ERROR_SIGNATURE)),
    'no schema RangeError may be raised'
  ).toEqual([])
  await expect(
    page.getByText(ERROR_BOUNDARY_TEXT),
    'rich markdown error boundary must not trip'
  ).toHaveCount(0)
}
