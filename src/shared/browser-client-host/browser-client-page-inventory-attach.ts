import {
  BROWSER_CLIENT_HOST_PAGE_INVENTORY_MAX_BYTES,
  BROWSER_CLIENT_HOST_PAGE_INVENTORY_MAX_PAGES,
  BrowserClientHostedPageInventoryList,
  browserClientHostedPageInventoryByteLength,
  type BrowserClientHostedPageInventory
} from '../browser-client-host-protocol'

export function prepareBrowserClientPageInventoryForAttach(
  pages: readonly BrowserClientHostedPageInventory[]
): readonly BrowserClientHostedPageInventory[] | undefined {
  if (pages.length > BROWSER_CLIENT_HOST_PAGE_INVENTORY_MAX_PAGES) {
    return undefined
  }
  const inventory: BrowserClientHostedPageInventory[] = []
  for (const page of pages) {
    const parsed = BrowserClientHostedPageInventoryList.element.safeParse(page)
    if (!parsed.success) {
      return undefined
    }
    inventory.push(parsed.data)
  }
  let inventoryBytes = browserClientHostedPageInventoryByteLength(inventory)
  if (inventoryBytes <= BROWSER_CLIENT_HOST_PAGE_INVENTORY_MAX_BYTES) {
    const prepared = BrowserClientHostedPageInventoryList.safeParse(inventory)
    return prepared.success ? prepared.data : undefined
  }
  const optionalUrls = inventory
    .flatMap((page, index) => {
      if (page.currentUrl === undefined) {
        return []
      }
      const withoutUrl = omitBrowserClientPageInventoryUrl(page)
      return [
        {
          browserPageId: page.browserPageId,
          index,
          savings:
            browserClientHostedPageInventoryByteLength([page]) -
            browserClientHostedPageInventoryByteLength([withoutUrl]),
          withoutUrl
        }
      ]
    })
    .sort(
      (left, right) =>
        right.savings - left.savings ||
        compareBrowserPageIds(left.browserPageId, right.browserPageId)
    )
  for (const candidate of optionalUrls) {
    if (inventoryBytes <= BROWSER_CLIENT_HOST_PAGE_INVENTORY_MAX_BYTES) {
      break
    }
    inventory[candidate.index] = candidate.withoutUrl
    inventoryBytes -= candidate.savings
  }
  const prepared = BrowserClientHostedPageInventoryList.safeParse(inventory)
  return prepared.success ? prepared.data : undefined
}

export function omitBrowserClientPageInventoryUrl(
  inventory: BrowserClientHostedPageInventory
): BrowserClientHostedPageInventory {
  const withoutUrl = { ...inventory }
  delete withoutUrl.currentUrl
  return withoutUrl
}

function compareBrowserPageIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
