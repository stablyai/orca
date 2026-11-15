import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  waitForActivePaneHookDescriptor,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'
import { waitForPtyShellEcho } from './terminal-pty-readiness'
import {
  claudeTranscriptLines,
  enableNativeChatSetting,
  seedClaudeProviderSession,
  toggleTerminalTabToChatView
} from './helpers/native-chat-transcript-fixture'

const REPLY = [
  'Both issues are fixed.',
  '- **Local tabs:** pass.\n- **Streamed pages:** pass.',
  '1. **First fix.** Done.\n2. **Second fix.** Done.'
].join('\n\n')

test('a reply sets paragraphs and list items on one line height, with bold in the body color', async ({
  orcaPage
}) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage, 30_000)
  await waitForPtyShellEcho(orcaPage, await waitForActivePanePtyId(orcaPage), 15_000)
  const descriptor = await waitForActivePaneHookDescriptor(orcaPage)
  const [tabId] = descriptor.paneKey.split(':')
  const sessionId = `e2e-typography-${randomUUID()}`
  const scratchDir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-native-chat-typography-'))
  const transcriptPath = path.join(scratchDir, `${sessionId}.jsonl`)
  writeFileSync(
    transcriptPath,
    claudeTranscriptLines({ sessionId, userText: 'How did it go?', assistantText: REPLY })
  )
  try {
    await enableNativeChatSetting(orcaPage)
    await seedClaudeProviderSession(orcaPage, { ...descriptor, sessionId, transcriptPath })
    await toggleTerminalTabToChatView(orcaPage, { tabId, worktreeId: descriptor.worktreeId })
    const reply = orcaPage.locator('[data-native-chat-window] .native-chat-markdown').filter({
      hasText: 'Both issues are fixed.'
    })
    await expect(reply.locator('li')).toHaveCount(4, { timeout: 30_000 })

    const measured = await reply.evaluate((markdown) => {
      const style = (selector: string) => getComputedStyle(markdown.querySelector(selector)!)
      const [first, second] = [...markdown.querySelectorAll('ul > li')]
      return {
        paragraph: { size: style('p').fontSize, line: style('p').lineHeight },
        item: { size: style('li').fontSize, line: style('li').lineHeight },
        blockGap: style('ul').marginTop,
        itemGap: second!.getBoundingClientRect().top - first!.getBoundingClientRect().bottom,
        body: style('p').color,
        bold: style('li strong').color
      }
    })
    // Text size 13px on 20px lines, the same for paragraphs and list items.
    expect(measured.paragraph).toEqual({ size: '13px', line: '20px' })
    expect(measured.item).toEqual(measured.paragraph)
    expect(measured.blockGap).toBe('10px')
    expect(measured.itemGap).toBeCloseTo(3, 1)
    expect(measured.bold).toBe(measured.body)
  } finally {
    rmSync(scratchDir, { recursive: true, force: true })
  }
})
