import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  cleanupMarkdownFixture,
  createMarkdownFixture,
  getActiveWorktreeContext,
  openMarkdownFixture,
  waitForRichMarkdownEditor
} from './helpers/markdown-ordered-list-exit'

async function openActiveMarkdownPreview(
  page: Parameters<typeof getActiveWorktreeContext>[0]
): Promise<void> {
  await page.evaluate(() => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }

    const state = store.getState()
    const file = state.openFiles.find((entry) => entry.id === state.activeFileId)
    if (!file) {
      throw new Error('No active editor file')
    }

    state.openMarkdownPreview(
      {
        filePath: file.filePath,
        relativePath: file.relativePath,
        worktreeId: file.worktreeId,
        runtimeEnvironmentId: file.runtimeEnvironmentId,
        language: 'markdown'
      },
      { sourceFileId: file.id }
    )
  })
}

test.describe('Markdown Mermaid SVG security', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
  })

  test('renders multiline labels and filters without exposing active SVG content', async ({
    orcaPage
  }, testInfo) => {
    const context = await getActiveWorktreeContext(orcaPage)
    let filePath: string | null = null

    try {
      const markdown = [
        '# Mermaid security fixture',
        '',
        '```mermaid',
        '%%{init: {"themeCSS": ".node{fill:url(https://attacker.invalid/fill)}", "htmlLabels": true}}%%',
        'flowchart LR',
        '  PATH3D["3D Ground‑Truth Trajectory Point P(x, y, z)"] --> EXT["<img src=x onerror=window.__mermaidSecurityProbe=1><script>window.__mermaidSecurityProbe=2</script>External"]',
        '  EXT --> JS["Javascript"]',
        '  click EXT href "https://example.com" "external" _blank',
        '  click JS href "javascript:window.__mermaidSecurityProbe=3" "bad" _blank',
        '```',
        ''
      ].join('\n')

      filePath = await createMarkdownFixture(
        context,
        'mermaid-security',
        testInfo.workerIndex,
        markdown
      )
      await orcaPage.evaluate(() => {
        ;(window as Window & { __mermaidSecurityProbe?: number }).__mermaidSecurityProbe = 0
      })
      await openMarkdownFixture(orcaPage, context, filePath)
      await waitForRichMarkdownEditor(orcaPage)
      await openActiveMarkdownPreview(orcaPage)

      const svg = orcaPage.locator('.mermaid-block svg').first()
      await expect(svg).toBeVisible({ timeout: 25_000 })
      await expect(svg).toContainText('3D Ground‑Truth Trajectory Point')
      await expect(orcaPage.locator('.mermaid-error')).toHaveCount(0)

      const securityState = await svg.evaluate((root) => {
        const attributes = Array.from(root.querySelectorAll('*')).flatMap((element) =>
          Array.from(element.attributes)
        )
        const links = Array.from(root.querySelectorAll('a')).map((link) => ({
          href: link.getAttribute('href') ?? link.getAttribute('xlink:href'),
          target: link.getAttribute('target')
        }))

        return {
          hasStyle: Boolean(root.querySelector('style')),
          hasFilter: Boolean(root.querySelector('filter')),
          hasForeignObject: Boolean(root.querySelector('foreignObject')),
          hasEventHandler: attributes.some((attribute) =>
            attribute.name.toLowerCase().startsWith('on')
          ),
          hasExternalThemeCss: root
            .querySelector('style')
            ?.textContent?.includes('attacker.invalid'),
          links
        }
      })

      expect(securityState).toMatchObject({
        hasStyle: true,
        hasFilter: true,
        hasForeignObject: false,
        hasEventHandler: false,
        hasExternalThemeCss: false
      })
      expect(securityState.links).not.toContainEqual(expect.objectContaining({ target: '_blank' }))
      expect(
        securityState.links.some((link) =>
          link.href?.trim().toLowerCase().startsWith('javascript:')
        )
      ).toBe(false)
      await expect
        .poll(() =>
          orcaPage.evaluate(
            () =>
              (window as Window & { __mermaidSecurityProbe?: number }).__mermaidSecurityProbe ?? 0
          )
        )
        .toBe(0)
    } finally {
      await cleanupMarkdownFixture(filePath)
    }
  })
})
