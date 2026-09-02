import type { Page } from '@stablyai/playwright-test'
import { expect } from '@stablyai/playwright-test'
import {
  createMarkdownFixture as createMarkdownFixtureIn,
  type ActiveWorktreeContext
} from './markdown-editor-fixture'

const DRAFT_SERIALIZATION_TIMEOUT_MS = 10_000
const FIXTURE_DIRECTORY = '.orca-e2e-markdown-ordered-list'

export {
  cleanupMarkdownFixture,
  getActiveWorktreeContext,
  openMarkdownFixture,
  waitForRichMarkdownEditor,
  type ActiveWorktreeContext
} from './markdown-editor-fixture'

export type MatrixRow = {
  name: string
  slug: string
  sentinel: string
  initialMarkdown: string
  run: (page: Page, sentinel: string) => Promise<void>
}

export async function createMarkdownFixture(
  context: ActiveWorktreeContext,
  slug: string,
  workerIndex: number,
  initialMarkdown: string
): Promise<string> {
  return createMarkdownFixtureIn(context, FIXTURE_DIRECTORY, slug, workerIndex, initialMarkdown)
}

export async function expectSentinelParagraphOutsideOrderedList(
  page: Page,
  sentinel: string
): Promise<void> {
  await expect
    .poll(
      async () =>
        page.evaluate((sentinel) => {
          const editor = document.querySelector('.rich-markdown-editor')
          if (!editor) {
            return false
          }

          return Array.from(editor.querySelectorAll('p')).some((paragraph) => {
            return (
              paragraph.textContent?.trim() === sentinel &&
              !paragraph.closest('ol') &&
              !paragraph.closest('li')
            )
          })
        }, sentinel),
      {
        timeout: 5_000,
        message: `${sentinel} did not render in a paragraph outside an ordered list`
      }
    )
    .toBe(true)
}

export async function expectSerializedDraftOutsideOrderedList(
  page: Page,
  draftKey: string,
  sentinel: string
): Promise<void> {
  await expect
    .poll(
      async () =>
        page.evaluate(
          ({ draftKey, sentinel }) => {
            const draft = window.__store?.getState().editorDrafts[draftKey]
            if (typeof draft !== 'string') {
              return false
            }

            const sentinelLines = draft
              .split(/\r\n|\r|\n/)
              .filter((line) => line.includes(sentinel))
            return {
              hasPlainLine: sentinelLines.some((line) => line.trim() === sentinel),
              appearsOnNumberedLine: sentinelLines.some((line) => /^\s*\d+\.\s+/.test(line))
            }
          },
          { draftKey, sentinel }
        ),
      {
        timeout: DRAFT_SERIALIZATION_TIMEOUT_MS,
        message: `${sentinel} did not serialize as a plain paragraph in editorDrafts[${draftKey}]`
      }
    )
    .toEqual({ hasPlainLine: true, appearsOnNumberedLine: false })
}

export async function assertLoadedThirdEmptyOrderedListItem(page: Page): Promise<void> {
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const editor = document.querySelector('.rich-markdown-editor')
          const listItems = Array.from(editor?.querySelectorAll('ol > li') ?? [])
          const thirdItem = listItems[2]
          const paragraph = thirdItem?.querySelector('p') ?? null
          const rect = paragraph?.getBoundingClientRect()
          return Boolean(
            thirdItem &&
            paragraph &&
            thirdItem.textContent?.trim() === '' &&
            rect &&
            rect.width > 0 &&
            rect.height > 0
          )
        }),
      {
        timeout: 5_000,
        message: 'Loaded markdown did not expose an editable empty third ordered-list item'
      }
    )
    .toBe(true)
}

async function selectionIsInsideThirdEmptyOrderedListItem(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const editor = document.querySelector('.rich-markdown-editor')
    const thirdItem = editor?.querySelectorAll('ol > li')[2] as
      | (Element & {
          pmViewDesc?: {
            node?: { type?: { name?: string } }
          }
        })
      | undefined
    const paragraph = thirdItem?.querySelector('p') as
      | (Element & {
          pmViewDesc?: {
            posAtStart?: number
            posAtEnd?: number
          }
        })
      | null
    const tiptapEditor = (
      editor as
        | (Element & {
            editor?: {
              state?: {
                selection?: {
                  empty?: boolean
                  from?: number
                  to?: number
                }
              }
            }
          })
        | null
    )?.editor
    const selection = tiptapEditor?.state?.selection
    const selectionFrom = selection?.from
    const selectionTo = selection?.to
    const paragraphStart = paragraph?.pmViewDesc?.posAtStart
    const paragraphEnd = paragraph?.pmViewDesc?.posAtEnd

    if (
      !thirdItem ||
      !paragraph ||
      !selection?.empty ||
      typeof selectionFrom !== 'number' ||
      typeof selectionTo !== 'number' ||
      typeof paragraphStart !== 'number' ||
      typeof paragraphEnd !== 'number'
    ) {
      return false
    }

    return (
      thirdItem.pmViewDesc?.node?.type?.name === 'listItem' &&
      thirdItem.textContent?.trim() === '' &&
      selectionFrom >= paragraphStart &&
      selectionTo <= paragraphEnd
    )
  })
}

export async function placeCaretInLoadedThirdEmptyItem(page: Page): Promise<void> {
  const thirdItemParagraph = page.locator('.rich-markdown-editor ol > li').nth(2).locator('p')
  await thirdItemParagraph.click()

  if (!(await selectionIsInsideThirdEmptyOrderedListItem(page))) {
    await page.evaluate(() => {
      const editor = document.querySelector('.rich-markdown-editor') as
        | (Element & {
            editor?: {
              commands?: {
                focus?: () => boolean
                setTextSelection?: (position: number) => boolean
              }
            }
          })
        | null
      const thirdItem = editor?.querySelectorAll('ol > li')[2]
      const paragraph = thirdItem?.querySelector('p') as
        | (Element & {
            pmViewDesc?: {
              posAtStart?: number
            }
          })
        | null
      const selectionPosition = paragraph?.pmViewDesc?.posAtStart
      if (!editor?.editor?.commands || typeof selectionPosition !== 'number') {
        throw new Error('Cannot place caret in the loaded empty ordered-list item')
      }

      // Why: headless Electron can click an empty paragraph without committing
      // ProseMirror's state selection before Enter; set the same caret explicitly.
      editor.editor.commands.setTextSelection?.(selectionPosition)
      editor.editor.commands.focus?.()
    })
  }

  await expect
    .poll(async () => selectionIsInsideThirdEmptyOrderedListItem(page), {
      timeout: 3_000,
      message: 'Selection was not inside the loaded empty third ordered-list item'
    })
    .toBe(true)
}
