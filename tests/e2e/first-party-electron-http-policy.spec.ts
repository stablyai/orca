import { createServer } from 'node:http'
import { test, expect } from './helpers/orca-app'

test.use({ seedTestRepo: false })

test('preserves Node request isolation on the Electron HTTP transport', async ({
  electronApp,
  orcaPage
}) => {
  let cacheHits = 0
  let redirectTargetHits = 0
  const cookieHeaders: (string | undefined)[] = []
  const server = createServer((request, response) => {
    if (request.url === '/policy') {
      cacheHits += 1
      cookieHeaders.push(request.headers.cookie)
      response.setHeader('cache-control', 'public, max-age=3600')
      response.end(`hit-${cacheHits}`)
      return
    }
    if (request.url === '/redirect') {
      response.writeHead(302, { location: '/redirect-target' }).end()
      return
    }
    redirectTargetHits += 1
    response.end('redirect-followed')
  })

  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('expected Electron policy fixture address')
    }
    const origin = `http://127.0.0.1:${address.port}`
    const result = await electronApp.evaluate(async ({ app, session }, fixtureOrigin) => {
      const { createRequire } = process.getBuiltinModule('node:module')
      const { join } = process.getBuiltinModule('node:path')
      const mainEntry = join(app.getAppPath(), 'out', 'main', 'index.js')
      const firstPartyFetch = (
        createRequire(mainEntry)(mainEntry) as {
          firstPartyFetch?: typeof globalThis.fetch
        }
      ).firstPartyFetch
      if (!firstPartyFetch) {
        throw new Error('firstPartyFetch is not exported by the Electron main entry')
      }
      await session.defaultSession.cookies.set({
        url: fixtureOrigin,
        name: 'orca_ambient',
        value: 'sensitive'
      })
      const policy: RequestInit = {
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error'
      }
      const first = await firstPartyFetch(`${fixtureOrigin}/policy`, policy)
      const firstBody = await first.text()
      const second = await firstPartyFetch(`${fixtureOrigin}/policy`, policy)
      const secondBody = await second.text()
      let redirectError = ''
      try {
        await firstPartyFetch(`${fixtureOrigin}/redirect`, policy)
      } catch (error) {
        redirectError = error instanceof Error ? error.message : String(error)
      }
      await session.defaultSession.cookies.remove(fixtureOrigin, 'orca_ambient')
      return { firstBody, secondBody, redirectError }
    }, origin)

    await expect(orcaPage.getByRole('heading', { name: 'ORCA' })).toBeVisible()
    expect(result).toMatchObject({ firstBody: 'hit-1', secondBody: 'hit-2' })
    expect(result.redirectError).toMatch(/redirect/i)
    expect(cookieHeaders).toEqual([undefined, undefined])
    expect(redirectTargetHits).toBe(0)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    )
  }
})
