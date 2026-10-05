import type { Page } from '@stablyai/playwright-test'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { quoteStartupArg } from '../../src/shared/tui-agent-startup-shell'
import { expect } from './helpers/orca-app'
import { getTerminalContent, sendToTerminal } from './helpers/terminal'

export async function launchIsolatedCodexComposer(
  page: Page,
  ptyId: string,
  scratch: string
): Promise<string> {
  const codexHome = path.join(scratch, 'codex-home')
  mkdirSync(codexHome, { recursive: true, mode: 0o700 })
  // Local provider skips login; the closed port is never contacted because the test does not submit.
  writeFileSync(
    path.join(codexHome, 'config.toml'),
    [
      'check_for_update_on_startup = false',
      'model_provider = "typing-fixture"',
      'model = "fixture-model"',
      '[model_providers.typing-fixture]',
      'name = "Typing fixture"',
      'base_url = "http://127.0.0.1:9/v1"',
      'wire_api = "responses"',
      'requires_openai_auth = false',
      'supports_websockets = false',
      '[tui]',
      'status_line = ["context-window-used"]',
      ''
    ].join('\n')
  )
  await sendToTerminal(
    page,
    ptyId,
    `CODEX_HOME=${quoteStartupArg(codexHome, 'posix')} codex --no-alt-screen\r`
  )
  let lastText = ''
  await expect
    .poll(
      async () => {
        lastText = await getTerminalContent(page, 8_000)
        if (/Ask Codex to do anything|Context \d+% used|\d+% context (left|used)/i.test(lastText)) {
          return true
        }
        if (/Do you trust|trust this folder|Trust this/i.test(lastText)) {
          await sendToTerminal(page, ptyId, '\r')
        }
        return false
      },
      { timeout: 60_000, message: 'Isolated Codex did not reach its input composer' }
    )
    .toBe(true)
  return lastText.match(/codex[^\r\n]{0,80}/i)?.[0] ?? 'composer-ready'
}
