import { test, expect } from './helpers/orca-app'
import { DOC_PREVIEW_PARTITION } from '../../src/shared/doc-preview-scheme'

test('document previews render in independent hidden windows without app privileges', async ({
  electronApp
}, testInfo) => {
  const main = await electronApp.firstWindow()
  await main.waitForFunction(() => Boolean(window.api?.docPreview))
  await main.evaluate(async () => {
    await window.api.docPreview.openMarkdownWindow({
      fileId: 'report.md',
      title: 'Agent report',
      html: '<!doctype html><html><body><h1>Agent report</h1><p>Read this on the second screen.</p><script>window.injected = true</script></body></html>'
    })
  })
  const markdown = electronApp.windows().find((page) => page.url().startsWith('data:'))
  if (!markdown) {
    throw new Error('Markdown window was not created')
  }
  await expect(markdown.getByRole('heading', { name: 'Agent report' })).toBeVisible()
  expect(await markdown.evaluate(() => 'api' in window || 'injected' in window)).toBe(false)
  await markdown.screenshot({ path: testInfo.outputPath('markdown-window.png') })

  // Why: fixture bytes isolate window rendering from SSH availability; grant/owner routing has unit coverage.
  await electronApp.evaluate(({ session }, partition) => {
    const protocol = session.fromPartition(partition).protocol
    protocol.unhandle('orca-preview')
    protocol.handle(
      'orca-preview',
      () =>
        new Response(
          '<!doctype html><html><body><h1>HTML report</h1><button onclick="this.textContent=\'Updated\'">Try interaction</button></body></html>',
          { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
        )
    )
  }, DOC_PREVIEW_PARTITION)
  const source = await main.evaluate(() =>
    window.api.docPreview.mintGrant({
      owner: { kind: 'ssh', connectionId: 'fixture-host' },
      requestBase: '/workspace',
      root: '/workspace/reports',
      entryRelativePath: 'reports/index.html',
      browserPageId: 'html-report'
    })
  )
  await main.evaluate((grantId) => window.api.docPreview.openHtmlWindow(grantId), source.grantId)
  const html = electronApp.windows().find((page) => page.url().startsWith('orca-preview:'))
  if (!html) {
    throw new Error('HTML window was not created')
  }
  await expect(html.getByRole('heading', { name: 'HTML report' })).toBeVisible()
  await html.getByRole('button', { name: 'Try interaction' }).click()
  await expect(html.getByRole('button', { name: 'Updated' })).toBeVisible()
  expect(await html.evaluate(() => 'api' in window || typeof require !== 'undefined')).toBe(false)
  await main.evaluate((grantId) => window.api.docPreview.revokeGrant(grantId), source.grantId)
  await html.reload()
  await expect(html.getByRole('heading', { name: 'HTML report' })).toBeVisible()
  await html.screenshot({ path: testInfo.outputPath('html-window.png') })
  expect(
    await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().every((window) => !window.isVisible())
    )
  ).toBe(true)
})
