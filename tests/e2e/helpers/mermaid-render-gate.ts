import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Page } from '@stablyai/playwright-test'
import type mermaid from 'mermaid'

export async function holdMermaidRendering(page: Page) {
  const assets = path.join(process.cwd(), 'out', 'renderer', 'assets')
  const entry = (await readdir(assets)).find((name) =>
    /^mermaid\.core-[A-Za-z0-9_-]+\.js$/.test(name)
  )
  if (!entry) {
    throw new Error('The built renderer has no Mermaid core entry')
  }
  return page.evaluateHandle(
    async (url) => {
      // The hashed browser chunk must be selected at runtime to share the renderer's real API.
      const module = await import(url)
      const api = Object.values(module).find(
        (value): value is Pick<typeof mermaid, 'render' | 'initialize'> =>
          value !== null &&
          typeof value === 'object' &&
          'render' in value &&
          typeof value.render === 'function' &&
          'initialize' in value &&
          typeof value.initialize === 'function'
      )
      if (!api) {
        throw new Error('The Mermaid core entry does not expose the real rendering API')
      }
      const original = api.render
      const barrier = Promise.withResolvers<void>()
      let calls = 0
      let completed = 0
      api.render = async (...args: Parameters<typeof original>) => {
        calls += 1
        await barrier.promise
        const result = await original.apply(api, args)
        completed += 1
        return result
      }
      return {
        calls: () => calls,
        completed: () => completed,
        release: () => barrier.resolve(),
        restore: () => {
          api.render = original
          barrier.resolve()
        }
      }
    },
    pathToFileURL(path.join(assets, entry)).href
  )
}
