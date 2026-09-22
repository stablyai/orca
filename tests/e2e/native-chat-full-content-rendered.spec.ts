import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron, expect, test, type Locator } from '@stablyai/playwright-test'
import {
  boundInlineText,
  DEFAULT_JOURNAL_PAYLOAD_LIMITS
} from '../../src/main/native-chat/agent-session-journal/journal-payload-bounds'
import { readOwnedPayloadRange } from '../../src/main/native-chat/agent-session-journal/journal-payload-read'
import {
  JournalPayloadStore,
  PAYLOAD_STORE_DIR_NAME
} from '../../src/main/native-chat/agent-session-journal/journal-payload-store'
import type { NativeChatMessage } from '../../src/shared/native-chat-types'

// Why: RTL under happy-dom proves the component tree, not what a person sees.
// This renders the REAL native-chat components (row, tool run, full-content
// button, i18n, Tailwind theme) in real Chromium, with the payload served by a
// REAL JournalPayloadStore through the owner-checked range reader, and keeps
// the screenshot as the rendered proof. The in-app structured route cannot be
// driven inside the e2e fixture (the structured Claude host needs the Agent
// SDK handshake and credentials the fixture strips), which is reported as the
// remaining gap rather than hidden by this proof.

const SESSION_SCOPE = 'session:rendered-proof'
const PROSE_SENTINEL = 'CONSTRAINT-C (prose): the constraint that lived past the head'
const TOOL_SENTINEL = 'CONSTRAINT-C (tool): the constraint that lived past the head'
const HARNESS_DIR = path.resolve(__dirname, '../../out-harness/full-content')
const HARNESS_MAIN = path.resolve(__dirname, 'fixtures/full-content-harness/electron-main.cjs')
const HARNESS_CONFIG = path.resolve(__dirname, 'fixtures/full-content-harness/vite.config.ts')
/** Named so a CI job — and this file's own failure message — can run exactly it. */
const HARNESS_BUILD_SCRIPT = 'build:e2e-full-content-harness'
const HARNESS_BUILD_TIMEOUT_MS = 180_000

/**
 * Builds the harness bundle this spec serves. `out-harness/` is gitignored and
 * the ordinary e2e build produces only the app, so without this the handler
 * 404s on index.html and the test times out on a missing element instead of
 * saying what is missing.
 */
function buildHarnessBundle(): void {
  if (process.env.SKIP_BUILD && existsSync(path.join(HARNESS_DIR, 'index.html'))) {
    return
  }
  const repoRoot = path.resolve(__dirname, '../..')
  try {
    // The vite entry is invoked through node directly: no shell, so the path
    // needs no quoting on any platform.
    execFileSync(
      process.execPath,
      [
        path.join(repoRoot, 'node_modules', 'vite', 'bin', 'vite.js'),
        'build',
        '--config',
        HARNESS_CONFIG
      ],
      { cwd: repoRoot, stdio: 'inherit', timeout: HARNESS_BUILD_TIMEOUT_MS }
    )
  } catch (error) {
    throw new Error(
      `The full-content harness bundle could not be built. Run \`pnpm run ${HARNESS_BUILD_SCRIPT}\` and retry. Underlying failure: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  if (!existsSync(path.join(HARNESS_DIR, 'index.html'))) {
    throw new Error(
      `The full-content harness bundle is missing at ${HARNESS_DIR}. Run \`pnpm run ${HARNESS_BUILD_SCRIPT}\` before this spec.`
    )
  }
}

function filler(prefix: string, bytes: number): string {
  const lines: string[] = []
  let index = 0
  while (lines.join('\n').length < bytes) {
    lines.push(
      `${prefix} line ${index++}: ordinary text that pushes the sentinel past the bounded head`
    )
  }
  return lines.join('\n')
}

/** Scrolls the element and every scrollable ancestor to its end. */
async function scrollToEnd(locator: Locator): Promise<void> {
  await locator.evaluate((element) => {
    let node: Element | null = element
    while (node) {
      node.scrollTop = node.scrollHeight
      node = node.parentElement
    }
  })
}

/** Serves the built harness bundle plus a `/payload` endpoint backed by the real
 *  owner-checked range reader, so the page fetches through production code. */
function serveHarness(args: { store: JournalPayloadStore; config: unknown }): Promise<Server> {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/config.json') {
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify(args.config))
      return
    }
    if (url.pathname === '/payload') {
      try {
        const digest = url.searchParams.get('digest') ?? ''
        const range = readOwnedPayloadRange({
          retention: args.store,
          isReferenced: () => args.store.isReferencedBy(digest, SESSION_SCOPE),
          digest,
          offset: Number(url.searchParams.get('offset') ?? '0'),
          limit: 16 * 1024,
          maxLimit: 256 * 1024
        })
        response.setHeader('Content-Type', 'application/json')
        response.end(JSON.stringify(range))
      } catch (error) {
        response.statusCode = 403
        response.end(error instanceof Error ? error.message : String(error))
      }
      return
    }
    const file = path.join(HARNESS_DIR, url.pathname === '/' ? 'index.html' : url.pathname)
    try {
      const body = readFileSync(file)
      response.setHeader(
        'Content-Type',
        file.endsWith('.html')
          ? 'text/html'
          : file.endsWith('.js')
            ? 'text/javascript'
            : file.endsWith('.css')
              ? 'text/css'
              : 'application/octet-stream'
      )
      response.end(body)
    } catch {
      response.statusCode = 404
      response.end('not found')
    }
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
}

test.beforeAll(() => {
  test.setTimeout(HARNESS_BUILD_TIMEOUT_MS + 30_000)
  buildHarnessBundle()
})

test('rendered: clipped prose and tool output open the complete original in real Chromium', async () => {
  test.setTimeout(120_000)
  const root = mkdtempSync(path.join(os.tmpdir(), 'orca-full-content-rendered-'))
  const store = new JournalPayloadStore({ directory: path.join(root, PAYLOAD_STORE_DIR_NAME) })
  const prose = `${filler('prose', 40 * 1024)}\n${PROSE_SENTINEL}`
  const toolOutput = `${filler('tool', 48 * 1024)}\n${TOOL_SENTINEL}\nEND OF ARTIFACT`
  // The same bounding the journal applies, with the store as its retention and
  // this session as the owning scope.
  const sessionRetention = {
    retain: (digest: string, payload: string) => store.retain(digest, payload, SESSION_SCOPE),
    retrieve: (digest: string) => store.retrieve(digest),
    retrieveRange: (digest: string, offset: number, limit: number) =>
      store.retrieveRange(digest, offset, limit),
    isReferencedBy: (digest: string, scope: string) => store.isReferencedBy(digest, scope)
  }
  const boundedProse = boundInlineText(prose, DEFAULT_JOURNAL_PAYLOAD_LIMITS, sessionRetention)
  const boundedTool = boundInlineText(toolOutput, DEFAULT_JOURNAL_PAYLOAD_LIMITS, sessionRetention)
  expect(boundedProse.bounded.truncated).toBe(true)
  expect(boundedTool.bounded.truncated).toBe(true)
  expect(boundedProse.text).not.toContain(PROSE_SENTINEL)
  expect(boundedTool.text).not.toContain(TOOL_SENTINEL)

  const messages: NativeChatMessage[] = [
    {
      id: 'assistant-prose',
      role: 'assistant',
      timestamp: 0,
      source: 'transcript',
      blocks: [
        {
          type: 'text',
          text: boundedProse.text,
          clipped: {
            digest: boundedProse.bounded.digest,
            byteLength: boundedProse.bounded.byteLength,
            retrievable: boundedProse.bounded.retrievable === true
          }
        }
      ]
    },
    {
      id: 'assistant-tool',
      role: 'assistant',
      timestamp: 0,
      source: 'transcript',
      blocks: [
        {
          type: 'tool-call',
          name: 'Bash',
          input: { command: 'cat artifact.md' },
          state: 'completed'
        },
        {
          type: 'tool-result',
          output: boundedTool.text,
          clipped: {
            digest: boundedTool.bounded.digest,
            byteLength: boundedTool.bounded.byteLength,
            retrievable: boundedTool.bounded.retrievable === true
          }
        }
      ]
    }
  ]

  const config: { endpoint: string; sessionId: string; messages: NativeChatMessage[] } = {
    endpoint: '',
    sessionId: 'rendered-proof',
    messages
  }
  const server = await serveHarness({ store, config })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('harness server has no TCP address')
  }
  const { port } = address
  const origin = `http://127.0.0.1:${port}`
  config.endpoint = `${origin}/payload`
  const evidenceDir = path.join(process.cwd(), 'validation-screenshots', 'native-chat-full-content')
  mkdirSync(evidenceDir, { recursive: true })
  // The app's own Electron/Chromium, in a hidden offscreen window: nothing is
  // shown or focused on the host while this renders.
  const harnessUrl = `${origin}/index.html?config=${encodeURIComponent(`${origin}/config.json`)}`
  // Started inside the try: a rejected `launch` must still hit `finally` below,
  // or the listening `server` and `root` temp dir outlive this test.
  let electronApp: Awaited<ReturnType<typeof electron.launch>> | null = null
  try {
    electronApp = await electron.launch({
      args: [HARNESS_MAIN],
      env: { ...process.env, HARNESS_URL: harnessUrl, ELECTRON_ENABLE_LOGGING: '0' }
    })
    const page = await electronApp.firstWindow()
    await expect(page.getByTestId('harness-root')).toBeVisible()
    // Both heads render honestly clipped: neither sentinel is on screen yet.
    await expect(page.getByText(PROSE_SENTINEL)).toHaveCount(0)
    await expect(page.getByText(TOOL_SENTINEL)).toHaveCount(0)
    // The tool result is a disclosure; open it the way a reader would.
    await page.getByText('Result', { exact: true }).click()
    const buttons = page.getByRole('button', { name: 'Show full content' })
    await expect(buttons).toHaveCount(2)
    await page.screenshot({ path: path.join(evidenceDir, '01-clipped-heads.png'), fullPage: true })
    // The visible marker names the size and digest so the head never poses as complete.
    await expect(
      page.getByText(/output truncated — \d+ bytes total, digest [0-9a-f]{12}/).first()
    ).toBeVisible()

    // Prose: the complete original, with the sentinel that lived past the head.
    await buttons.nth(0).click()
    const dialog = page.getByTestId('native-chat-full-content')
    await expect(dialog).toContainText(PROSE_SENTINEL, { timeout: 15_000 })
    await expect(dialog).toHaveText(prose)
    await expect(dialog).toBeVisible()
    // The dialog is a fixed overlay: capture it as an element, then scroll its
    // text to the end so the page capture shows the sentinel on screen.
    await page.locator('[role="dialog"]').screenshot({
      path: path.join(evidenceDir, '02-prose-full-content-dialog.png')
    })
    await scrollToEnd(dialog)
    await expect(dialog.getByText(PROSE_SENTINEL)).toBeInViewport()
    await page.screenshot({ path: path.join(evidenceDir, '02-prose-full-content.png') })
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)

    // Tool output: same route through the tool line.
    await buttons.nth(1).click()
    await expect(dialog).toContainText(TOOL_SENTINEL, { timeout: 15_000 })
    await expect(dialog).toHaveText(toolOutput)
    await expect(dialog).toBeVisible()
    await page.locator('[role="dialog"]').screenshot({
      path: path.join(evidenceDir, '03-tool-full-content-dialog.png')
    })
    await scrollToEnd(dialog)
    await expect(dialog.getByText(TOOL_SENTINEL)).toBeInViewport()
    await page.screenshot({ path: path.join(evidenceDir, '03-tool-full-content.png') })
    await page.keyboard.press('Escape')

    // A digest this session never referenced is refused by the same reader, and
    // the refusal is shown instead of the head being presented as complete.
    const strangerDigest = 'f'.repeat(64)
    const refused = await page.evaluate(async (url) => {
      const response = await fetch(url)
      return { status: response.status, text: await response.text() }
    }, `${origin}/payload?digest=${strangerDigest}&offset=0`)
    expect(refused.status).toBe(403)
    expect(refused.text).toMatch(/not referenced/)
  } finally {
    await electronApp?.close()
    server.close()
    rmSync(root, { recursive: true, force: true })
  }
})
