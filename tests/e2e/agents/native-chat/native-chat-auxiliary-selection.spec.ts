// A selection made from a reply that is still streaming opens one unlisted, empty side chat.
import type { Locator, Page } from '@stablyai/playwright-test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import '../../desktop/electron-fixtures/orca-app'
import { expect } from '@stablyai/playwright-test'
import {
  SUPPORTED,
  openOmpStubChat,
  readOmpEvents,
  test,
  type OmpStubEvent
} from '../session-fixtures/structured-omp-stub'

const WARMUP_PROMPT = 'PARENT-WARMUP'
const PARENT_STABLE_REPLY = 'PARENT-STABLE-REPLY'
const PARENT_CURRENT_USER = 'SLOW-PARENT-CURRENT-USER'
const FIRST_SELECTION = 'SELECTED FIRST'
const SECOND_SELECTION = 'PARENT-SECOND-SELECTED'
const UNFINISHED_PARENT_DELTA = 'PARENT-UNFINISHED-DELTA'
const SIDE_QUESTION = 'SLOW-CHILD What is the selected text about?'

type AuxiliaryConversation = {
  parentSessionId: string
  children: { sessionId: string }[]
  activeChildSessionId: string | null
}

function readAuxiliaryConversation(page: Page, parentSessionId: string) {
  return page.evaluate((parentSessionId) => {
    const state = window.__store?.getState() as unknown as {
      nativeChatAuxiliaryByParent?: Record<string, AuxiliaryConversation>
    }
    return (
      Object.values(state.nativeChatAuxiliaryByParent ?? {}).find(
        (conversation) => conversation.parentSessionId === parentSessionId
      ) ?? null
    )
  }, parentSessionId)
}

function readMainTabs(page: Page, worktreeId: string) {
  return page.evaluate((worktreeId) => {
    const state = window.__store?.getState() as unknown as {
      unifiedTabsByWorktree?: Record<string, { id: string; entityId: string }[]>
    }
    return (state.unifiedTabsByWorktree?.[worktreeId] ?? []).map((tab) => ({
      id: tab.id,
      entityId: tab.entityId
    }))
  }, worktreeId)
}

function fileContains(filePath: string, fragments: readonly string[]): boolean {
  try {
    const text = readFileSync(filePath, 'utf8')
    return fragments.every((fragment) => text.includes(fragment))
  } catch {
    return false
  }
}

function fileDigest(filePath: string): string {
  try {
    return createHash('sha256').update(readFileSync(filePath)).digest('hex')
  } catch {
    return 'missing'
  }
}

function promptText(event: OmpStubEvent): string {
  return (event.params?.prompt ?? []).flatMap((block) => (block.text ? [block.text] : [])).join('')
}

/** Drag-select a visible phrase with the real pointer, then right-click inside it. */
async function askInAuxiliary(page: Page, root: Locator, text: string): Promise<void> {
  const edges = await root.evaluate((element, text) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const value = (node as Text).data
      const index = value.indexOf(text)
      if (index === -1) {
        continue
      }
      const glyphEdge = (offset: number, side: 'start' | 'end') => {
        const range = document.createRange()
        range.setStart(node as Text, side === 'start' ? offset : offset - 1)
        range.setEnd(node as Text, side === 'start' ? offset + 1 : offset)
        const rect = range.getBoundingClientRect()
        return { x: side === 'start' ? rect.left : rect.right, y: rect.top + rect.height / 2 }
      }
      return { start: glyphEdge(index, 'start'), end: glyphEdge(index + text.length, 'end') }
    }
    throw new Error(`No visible text: ${text}`)
  }, text)
  await page.mouse.move(edges.start.x, edges.start.y)
  await page.mouse.down()
  await page.mouse.move(edges.end.x, edges.end.y, { steps: 12 })
  await page.mouse.up()
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.toString() ?? ''))
    .toContain(text)
  const point = await page.evaluate(() => {
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      throw new Error('the transcript selection was lost')
    }
    const rect = selection.getRangeAt(0).getBoundingClientRect()
    // Keep clear of the selection offer anchored at the range's end.
    return { x: rect.left + Math.max(1, rect.width / 4), y: rect.top + rect.height / 2 }
  })
  await page.mouse.click(point.x, point.y, { button: 'right' })
  const item = page.getByRole('menuitem', { name: 'Ask in auxiliary chat' })
  await expect(item).toBeEnabled({ timeout: 15_000 })
  await item.click()
}

test.describe('native chat selection into an auxiliary chat', () => {
  test.skip(!SUPPORTED, 'the OMP ACP stub wrapper is POSIX-only')

  test('streaming selection reuses one empty child and sends a stable snapshot', async ({
    orcaPage: page,
    ompStub
  }) => {
    // The side panel's shared gate requires a wide enough window to compare chats.
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeGreaterThanOrEqual(900)
    const parent = await openOmpStubChat(page, ompStub)
    const starReminder = page.getByRole('complementary', { name: 'Enjoying Orca?' })
    await page.addLocatorHandler(starReminder, async (reminder) => {
      await reminder.getByRole('button', { name: 'Dismiss', exact: true }).click()
    })

    await parent.composer.click()
    await page.keyboard.type(WARMUP_PROMPT)
    await parent.send.click()
    await expect(parent.chat.getByText(PARENT_STABLE_REPLY, { exact: true })).toBeVisible({
      timeout: 30_000
    })

    await parent.composer.click()
    await page.keyboard.type(PARENT_CURRENT_USER)
    await parent.send.click()
    await expect(parent.chat.getByText(FIRST_SELECTION, { exact: false })).toBeVisible({
      timeout: 30_000
    })
    await expect(parent.chat.getByText(SECOND_SELECTION, { exact: false })).toBeVisible()
    await expect(parent.stop).toBeVisible()

    await expect
      .poll(
        () =>
          readOmpEvents(ompStub.eventsPath).find(
            (event) => event.kind === 'prompt' && promptText(event).includes(WARMUP_PROMPT)
          )?.sessionId ?? null,
        { timeout: 30_000 }
      )
      .toBeTruthy()
    const parentPrompt = readOmpEvents(ompStub.eventsPath).find(
      (event) => event.kind === 'prompt' && promptText(event).includes(WARMUP_PROMPT)
    )
    const parentProviderSessionId = parentPrompt?.sessionId
    const parentFile = readOmpEvents(ompStub.eventsPath).find(
      (event) => event.kind === 'session/new' && event.sessionId === parentProviderSessionId
    )?.filePath
    if (!parentFile) {
      throw new Error('the parent provider never created an OMP session file')
    }
    await expect
      .poll(() => fileContains(parentFile, [PARENT_CURRENT_USER, UNFINISHED_PARENT_DELTA]), {
        timeout: 30_000
      })
      .toBe(true)
    const parentDigest = fileDigest(parentFile)

    const tabsBefore = await readMainTabs(page, parent.worktreeId)
    await askInAuxiliary(page, parent.chat, FIRST_SELECTION)
    const sideChat = page.locator('[data-side-chat-panel]')
    const refusal = page.locator('[data-sonner-toast][data-type="error"]').first()
    await expect(sideChat.or(refusal)).toBeVisible({ timeout: 15_000 })
    if (await refusal.isVisible()) {
      throw new Error(`Unable to open auxiliary chat: ${await refusal.innerText()}`)
    }
    const conversation = await readAuxiliaryConversation(page, parent.sessionId)
    if (!conversation) {
      throw new Error('the auxiliary conversation was not registered')
    }
    const childSessionId = conversation.activeChildSessionId
    if (!childSessionId) {
      throw new Error('the auxiliary conversation has no active child')
    }
    expect(childSessionId).not.toBe(parent.sessionId)

    const tabsAfter = await readMainTabs(page, parent.worktreeId)
    expect(tabsAfter).toHaveLength(tabsBefore.length)
    expect(tabsAfter.some((tab) => tab.entityId === childSessionId)).toBe(false)

    await expect(sideChat).toHaveAttribute('data-side-chat-parent-session', parent.sessionId, {
      timeout: 30_000
    })
    await expect(sideChat).toHaveAttribute('data-side-chat-active-child', childSessionId)
    await expect(sideChat.locator('[data-side-chat-tab]')).toHaveCount(1)
    const childChat = sideChat
      .locator(`[data-side-chat-child="${childSessionId}"]`)
      .locator('[data-native-chat-root="true"]')
    const pendingReferences = childChat.locator('[data-native-chat-auxiliary-reference-count]')
    await expect(pendingReferences).toHaveAttribute(
      'data-native-chat-auxiliary-reference-count',
      '1'
    )
    await expect(childChat.locator('[data-native-chat-auxiliary-reference]')).toHaveCount(1)
    await expect(childChat.getByText(FIRST_SELECTION, { exact: true })).toBeVisible()
    await expect(childChat.locator('[data-native-chat-selection-row]')).toHaveCount(0)
    const childComposer = childChat.getByRole('textbox')
    await expect
      .poll(() => childComposer.evaluate((element) => element.textContent?.trim() ?? ''))
      .toBe('')
    await expect(parent.stop).toBeVisible()
    await expect(parent.chat.getByText(FIRST_SELECTION, { exact: false })).toBeVisible()

    // Escape inside the child composer must not read as the source chat's stop shortcut.
    await childComposer.click()
    await page.keyboard.press('Escape')
    await expect(parent.stop).toBeVisible()
    await expect(parent.chat.getByText(FIRST_SELECTION, { exact: false })).toBeVisible()

    await askInAuxiliary(page, parent.chat, SECOND_SELECTION)
    await expect(pendingReferences).toHaveAttribute(
      'data-native-chat-auxiliary-reference-count',
      '2',
      { timeout: 15_000 }
    )
    await expect(childChat.locator('[data-native-chat-auxiliary-reference]')).toHaveCount(2)
    await expect
      .poll(
        async () => (await readAuxiliaryConversation(page, parent.sessionId))?.children.length ?? 0
      )
      .toBe(1)
    await expect(sideChat.locator('[data-side-chat-tab]')).toHaveCount(1)
    await expect(sideChat).toHaveAttribute('data-side-chat-active-child', childSessionId)
    await expect(parent.stop).toBeVisible()
    await expect(parent.chat.getByText(SECOND_SELECTION, { exact: false })).toBeVisible()
    expect(fileDigest(parentFile)).toBe(parentDigest)

    await childComposer.click()
    await page.keyboard.type(SIDE_QUESTION)
    await childChat.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(childChat.locator('[data-native-chat-sent-reference-count]')).toHaveAttribute(
      'data-native-chat-sent-reference-count',
      '2',
      { timeout: 30_000 }
    )
    await expect(childChat.getByText(SIDE_QUESTION, { exact: true })).toBeVisible()

    await expect
      .poll(
        () => {
          const prompt = readOmpEvents(ompStub.eventsPath).find(
            (event) => event.kind === 'prompt' && promptText(event).includes(SIDE_QUESTION)
          )
          const load = prompt
            ? readOmpEvents(ompStub.eventsPath).find(
                (event) => event.kind === 'session/load' && event.sessionId === prompt.sessionId
              )
            : undefined
          return Boolean(prompt && load)
        },
        { timeout: 30_000 }
      )
      .toBe(true)

    const events = readOmpEvents(ompStub.eventsPath)
    const prompt = events.find(
      (event) => event.kind === 'prompt' && promptText(event).includes(SIDE_QUESTION)
    )
    if (!prompt?.sessionId) {
      throw new Error('the child provider never received the side question')
    }
    expect(prompt.sessionId).not.toBe(parentProviderSessionId)
    const load = events.find(
      (event) => event.kind === 'session/load' && event.sessionId === prompt.sessionId
    )
    if (!load?.filePath) {
      throw new Error('the child provider never loaded the derived snapshot')
    }
    expect(load.filePath.endsWith(`_${prompt.sessionId}.jsonl`)).toBe(true)
    expect(load.context?.header?.parentSession).toBe(parentProviderSessionId)
    expect(load.context?.header?.id).toBe(prompt.sessionId)

    const loadedContext = (load.context?.messages ?? []).map((message) => message.text).join('\n')
    expect(loadedContext).toContain(WARMUP_PROMPT)
    expect(loadedContext).toContain(PARENT_STABLE_REPLY)
    expect(loadedContext).toContain(PARENT_CURRENT_USER)
    expect(loadedContext).not.toContain(UNFINISHED_PARENT_DELTA)

    const derived = readFileSync(load.filePath, 'utf8')
    expect(derived).toContain(PARENT_CURRENT_USER)
    expect(derived).toContain(PARENT_STABLE_REPLY)
    expect(derived).not.toContain(UNFINISHED_PARENT_DELTA)
    expect(derived).toContain('<system-reminder>')
    expect(derived).toContain('"synthetic":true')
    expect(fileDigest(parentFile)).toBe(parentDigest)

    const sentPrompt = promptText(prompt)
    expect(sentPrompt).toContain(SIDE_QUESTION)
    expect(sentPrompt).toContain('# userselect:')
    expect(sentPrompt).toContain('```userselect')
    expect(sentPrompt).toContain(
      JSON.stringify([{ text: FIRST_SELECTION }, { text: SECOND_SELECTION }])
    )
    expect(sentPrompt).not.toContain(UNFINISHED_PARENT_DELTA)
    expect(sentPrompt).not.toContain(PARENT_STABLE_REPLY)

    await expect(childChat.getByText(FIRST_SELECTION, { exact: true })).toBeVisible()
    await expect(childChat.getByText(SECOND_SELECTION, { exact: true })).toBeVisible()
    await expect(childChat.getByText('# userselect:', { exact: false })).toHaveCount(0)
    const childStop = childChat.locator('[data-native-chat-critical-action="stop"]')
    await expect(childStop).toBeVisible({ timeout: 30_000 })
    await expect(parent.stop).toBeVisible()

    await childStop.click()
    await expect(childStop).toHaveCount(0, { timeout: 30_000 })
    await expect(parent.stop).toBeVisible()
    await expect(parent.chat.getByText(SECOND_SELECTION, { exact: false })).toBeVisible()

    await sideChat.locator(`[data-side-chat-tab="${childSessionId}"]`).hover()
    await sideChat.locator(`[data-side-chat-close="${childSessionId}"]`).click()
    await expect(sideChat.locator(`[data-side-chat-child="${childSessionId}"]`)).toHaveCount(0, {
      timeout: 30_000
    })
    await expect
      .poll(
        async () => (await readAuxiliaryConversation(page, parent.sessionId))?.children.length ?? -1
      )
      .toBe(0)
    await expect(parent.stop).toBeVisible()
    await expect(parent.chat.getByText(SECOND_SELECTION, { exact: false })).toBeVisible()
    expect(await readMainTabs(page, parent.worktreeId)).toHaveLength(tabsBefore.length)
  })
})
