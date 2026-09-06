import type { Page } from '@stablyai/playwright-test'

/**
 * Every `<webview>` a browser pane ever attached, in order, with the partition it was born with.
 *
 * Why a census instead of a DOM read: Electron partitions are immutable after creation, so the
 * pane replaces a guest whenever the partition it should use changes. A guest that mounts on the
 * wrong session and is swapped out a frame later leaves no trace for `querySelector` — only an
 * observer running from before the first mount can prove it never happened.
 *
 * The SSH-routing gate's own cards land on the same timeline so a spec can assert the ordering
 * between "the gate is still holding the mount" and "a guest attached". Card titles are matched
 * on `characterData` as well as added nodes: React reuses the title element across the
 * preparing -> error transition and rewrites only its text, which is not a childList mutation.
 */
export type BrowserPaneMountCensusEntry =
  | { kind: 'webview'; overlayTabId: string | null; partition: string | null; at: number }
  | {
      kind: 'gate-preparing' | 'gate-error'
      overlayTabId: string | null
      title: string
      at: number
    }

const GATE_PREPARING_TITLE = 'Connecting through the SSH host'
const GATE_ERROR_TITLES = [
  'SSH browser routing unavailable',
  'The SSH server blocks browser traffic',
  'SSH connection unavailable'
]
const CENSUS_KEY = '__orcaBrowserPaneMountCensus'

/** Must run before the first browser tab of interest is created. Idempotent per page. */
export async function installBrowserPaneMountCensus(page: Page): Promise<void> {
  await page.evaluate(
    ({ censusKey, preparingTitle, errorTitles }) => {
      const scope = window as unknown as Record<string, unknown>
      if (scope[censusKey]) {
        return
      }
      const census: BrowserPaneMountCensusEntry[] = []
      scope[censusKey] = census
      const overlayTabIdOf = (node: Node | null): string | null => {
        const element = node instanceof Element ? node : (node?.parentElement ?? null)
        return (
          element
            ?.closest('[data-browser-overlay-tab-id]')
            ?.getAttribute('data-browser-overlay-tab-id') ?? null
        )
      }
      const depthOf = (element: Element): number => {
        let depth = 0
        for (let cursor = element.parentElement; cursor; cursor = cursor.parentElement) {
          depth += 1
        }
        return depth
      }
      /**
       * The element that actually carries `title`, not merely an ancestor containing it.
       *
       * Why: React can insert a pane's whole subtree in one mutation, and resolving the overlay id
       * from the inserted ROOT walks upwards past it — the card would be filed under `null` and a
       * per-pane assertion would silently lose it.
       */
      const titleBearer = (root: Element, title: string): Element | null => {
        if (!(root.textContent ?? '').includes(title)) {
          return null
        }
        let deepest = root
        for (const candidate of root.querySelectorAll('*')) {
          if (
            (candidate.textContent ?? '').includes(title) &&
            depthOf(candidate) > depthOf(deepest)
          ) {
            deepest = candidate
          }
        }
        return deepest
      }
      const recordCardTitle = (
        node: Node,
        kind: 'gate-preparing' | 'gate-error',
        title: string
      ) => {
        census.push({ kind, overlayTabId: overlayTabIdOf(node), title, at: Date.now() })
      }
      const recordSubtreeCardTitles = (root: Element): void => {
        const preparing = titleBearer(root, preparingTitle)
        if (preparing) {
          recordCardTitle(preparing, 'gate-preparing', preparingTitle)
        }
        for (const title of errorTitles) {
          const bearer = titleBearer(root, title)
          if (bearer) {
            recordCardTitle(bearer, 'gate-error', title)
          }
        }
      }
      const recordTextCardTitles = (node: Node, text: string): void => {
        if (text.includes(preparingTitle)) {
          recordCardTitle(node, 'gate-preparing', preparingTitle)
        }
        for (const title of errorTitles) {
          if (text.includes(title)) {
            recordCardTitle(node, 'gate-error', title)
          }
        }
      }
      const recordAddedNode = (node: Node): void => {
        if (!(node instanceof Element)) {
          recordTextCardTitles(node, node.nodeValue ?? '')
          return
        }
        const webviews = node.tagName === 'WEBVIEW' ? [node] : [...node.querySelectorAll('webview')]
        for (const webview of webviews) {
          census.push({
            kind: 'webview',
            overlayTabId: overlayTabIdOf(webview),
            partition: webview.getAttribute('partition'),
            at: Date.now()
          })
        }
        recordSubtreeCardTitles(node)
      }
      const observer = new MutationObserver((records) => {
        for (const mutation of records) {
          if (mutation.type === 'characterData') {
            recordTextCardTitles(mutation.target, mutation.target.nodeValue ?? '')
            continue
          }
          for (const added of mutation.addedNodes) {
            recordAddedNode(added)
          }
        }
      })
      observer.observe(document.body, { childList: true, subtree: true, characterData: true })
    },
    {
      censusKey: CENSUS_KEY,
      preparingTitle: GATE_PREPARING_TITLE,
      errorTitles: GATE_ERROR_TITLES
    }
  )
}

export async function readBrowserPaneMountCensus(
  page: Page
): Promise<BrowserPaneMountCensusEntry[]> {
  return page.evaluate((censusKey) => {
    const census = (window as unknown as Record<string, unknown>)[censusKey]
    return Array.isArray(census) ? ([...census] as BrowserPaneMountCensusEntry[]) : []
  }, CENSUS_KEY)
}
