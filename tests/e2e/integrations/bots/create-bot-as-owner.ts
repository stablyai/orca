import type { Page } from '@stablyai/playwright-test'

/** Creates a bot as the owner does, from the app: a CLI caller counts as an agent, and a bot can't create a bot. */
export async function createBotAsOwner(page: Page, name: string): Promise<unknown> {
  return page.evaluate(async (botName) => {
    const created = await window.api.runtime.call({
      method: 'bots.create',
      params: { name: botName, agent: 'claude' }
    })
    if (!created.ok) {
      throw new Error(created.error.message)
    }
    return created.result
  }, name)
}
