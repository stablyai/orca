import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { postClaudeHook, readHookEndpoint } from './helpers/agent-hook-endpoint'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  execInTerminal,
  sendToTerminal,
  waitForActivePaneHookDescriptor,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'

const SESSION = '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f'

function readLines(path: string): string[] {
  try {
    return readFileSync(path, 'utf8').split('\n').filter(Boolean)
  } catch {
    return []
  }
}

function tabCustomTitle(page: Page, tabId: string): Promise<string | null> {
  return page.evaluate((id) => {
    for (const tabs of Object.values(window.__store!.getState().tabsByWorktree)) {
      const tab = tabs?.find((candidate) => candidate.id === id)
      if (tab) {
        return tab.customTitle ?? null
      }
    }
    return null
  }, tabId)
}

test('a Claude terminal tab and its session share one name', async ({
  orcaPage,
  electronApp,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  test.skip(process.platform === 'win32', 'The stub agent is a POSIX script')
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'orca-claude-name-')))
  registerPostElectronShutdownCleanup(async () => rmSync(dir, { recursive: true, force: true }))
  const submitted = join(dir, 'submitted.txt')
  const transcript = join(dir, `${SESSION}.jsonl`)
  writeFileSync(transcript, '')
  const stub = join(dir, 'claude')
  // Records each submitted line; `/rename` behaves as Claude's: transcript entry, then window title.
  writeFileSync(
    stub,
    `#!${process.execPath}
const fs = require('node:fs')
process.stdin.setRawMode(true)
process.stdin.resume()
process.stdout.write('\\x1b]0;Claude Code\\x07CLAUDE STUB READY\\r\\n')
let line = ''
process.stdin.on('data', (data) => {
  for (const ch of data.toString().replace(/\\x1b\\[20[01]~/g, '')) {
    if (ch !== '\\r') {
      line += ch >= ' ' ? ch : ''
      continue
    }
    fs.appendFileSync(${JSON.stringify(submitted)}, line + '\\n')
    if (line.startsWith('/rename ')) {
      const name = line.slice('/rename '.length).trim()
      fs.appendFileSync(${JSON.stringify(transcript)}, JSON.stringify({ type: 'custom-title', customTitle: name, sessionId: ${JSON.stringify(SESSION)} }) + '\\n')
      process.stdout.write('\\x1b]0;' + name + '\\x07Session renamed to: ' + name + '\\r\\n')
    }
    line = ''
  }
})
`
  )
  chmodSync(stub, 0o755)

  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage, 30_000)
  const ptyId = await waitForActivePanePtyId(orcaPage)
  const pane = await waitForActivePaneHookDescriptor(orcaPage)
  const tabId = pane.paneKey.split(':')[0]
  await execInTerminal(orcaPage, ptyId, stub)
  await waitForTerminalOutput(orcaPage, 'CLAUDE STUB READY')

  const endpoint = await readHookEndpoint(electronApp)
  await postClaudeHook(endpoint, pane, {
    hook_event_name: 'SessionStart',
    source: 'startup',
    session_id: SESSION,
    transcript_path: transcript,
    cwd: dir
  })
  // Claude sends its transcript path with every hook event.
  await postClaudeHook(endpoint, pane, {
    hook_event_name: 'Stop',
    session_id: SESSION,
    transcript_path: transcript
  })

  // Orca → Claude: renaming the tab types /rename into the session.
  await orcaPage.evaluate(
    (id) => window.__store!.getState().setTabCustomTitle(id, 'orca named'),
    tabId
  )
  await expect.poll(() => readLines(submitted), { timeout: 30_000 }).toEqual(['/rename orca named'])

  // Claude → Orca: a /rename typed in the session renames the tab, and is not sent back.
  await sendToTerminal(orcaPage, ptyId, '/rename typed in claude\r')
  await expect
    .poll(() => tabCustomTitle(orcaPage, tabId), { timeout: 15_000 })
    .toBe('typed in claude')
  await expect(orcaPage.getByText('typed in claude', { exact: true }).first()).toBeVisible()
  await orcaPage.screenshot({ path: testInfo.outputPath('claude-session-name-sync.png') })
  // Give an echo time to arrive before proving there was none.
  // ast-grep-ignore: test-no-real-time-wait -- proving no echo arrives needs a real window; there is no signal for an absent rename
  await orcaPage.waitForTimeout(2_000)
  expect(readLines(submitted)).toEqual(['/rename orca named', '/rename typed in claude'])
})
