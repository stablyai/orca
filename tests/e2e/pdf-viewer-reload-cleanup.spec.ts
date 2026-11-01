import { rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'
import { createPdfFindFixture } from './helpers/pdf-find-fixture'

test('PDF reloads release workers, scroll listeners, and localization observers', async ({
  orcaPage,
  seededRepoPath,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  const cdp = await orcaPage.context().newCDPSession(orcaPage)
  await orcaPage.evaluate(() => {
    const observers = new Set<MutationObserver>()
    const NativeMutationObserver = window.MutationObserver
    window.MutationObserver = class extends NativeMutationObserver {
      observe(target: Node, options?: MutationObserverInit): void {
        super.observe(target, options)
        if (
          target instanceof HTMLElement &&
          target.classList.contains('scrollbar-editor') &&
          target.querySelector('.pdfViewer')
        ) {
          observers.add(this)
        }
      }
      disconnect(): void {
        observers.delete(this)
        super.disconnect()
      }
    }
    Object.defineProperty(window, '__pdfReviewLiveMutationObservers', { get: () => observers.size })
  })
  const filePath = path.join(seededRepoPath, 'pdf-perf-review.pdf')
  registerPostElectronShutdownCleanup(async () => rmSync(filePath, { force: true }))
  writeFileSync(filePath, createPdfFindFixture({ title: 'Build 0' }))
  await orcaPage.evaluate((filePath) => {
    const state = window.__store?.getState()
    if (!state?.activeWorktreeId) {
      throw new Error('No fixture worktree')
    }
    state.openFile({
      filePath,
      relativePath: 'pdf-perf-review.pdf',
      worktreeId: state.activeWorktreeId,
      language: 'plaintext',
      mode: 'edit'
    })
  }, filePath)
  const pageText = orcaPage.locator('.pdfViewer .page').first().locator('.textLayer')
  await expect(pageText).toContainText('Build 0 - page 1')
  const samples: object[] = []
  const countWorkers = () =>
    orcaPage.workers().filter((worker) => worker.url().includes('pdf.worker')).length
  await expect.poll(countWorkers).toBe(1)
  for (let build = 1; build <= 12; build += 1) {
    const captured = await cdp.send('Runtime.evaluate', {
      expression: `globalThis.__pdfReviewPreviousContainer = document.querySelector('.pdfViewer').parentElement; getEventListeners(globalThis.__pdfReviewPreviousContainer).scroll.length`,
      includeCommandLineAPI: true,
      returnByValue: true
    })
    expect(captured.result.value).toBe(1)
    writeFileSync(filePath, createPdfFindFixture({ title: `Build ${build}` }))
    await expect(pageText).toContainText(`Build ${build} - page 1`)
    await expect.poll(countWorkers).toBe(1)
    const listeners = await cdp.send('Runtime.evaluate', {
      expression: `({ current: (getEventListeners(document.querySelector('.pdfViewer').parentElement).scroll || []).length, previous: (getEventListeners(globalThis.__pdfReviewPreviousContainer).scroll || []).length })`,
      includeCommandLineAPI: true,
      returnByValue: true
    })
    expect(listeners.result.value).toEqual({ current: 1, previous: 1 })
    const observers = await cdp.send('Runtime.evaluate', {
      expression: 'globalThis.__pdfReviewLiveMutationObservers',
      returnByValue: true
    })
    expect(observers.result.value).toBe(1)
    samples.push({
      build,
      workers: countWorkers(),
      listeners: listeners.result.value,
      localizationObservers: observers.result.value
    })
  }
  await orcaPage.evaluate(() => {
    const state = window.__store?.getState()
    const file = state?.openFiles.find((candidate) =>
      candidate.filePath.endsWith('pdf-perf-review.pdf')
    )
    if (!state || !file) {
      throw new Error('No PDF tab')
    }
    state.closeFile(file.id)
  })
  await expect(orcaPage.locator('.pdfViewer')).toHaveCount(0)
  await expect.poll(countWorkers).toBe(0)
  const closedListeners = await cdp.send('Runtime.evaluate', {
    expression: `(getEventListeners(globalThis.__pdfReviewPreviousContainer).scroll || []).length`,
    includeCommandLineAPI: true,
    returnByValue: true
  })
  expect(closedListeners.result.value).toBe(0)
  const closedObservers = await cdp.send('Runtime.evaluate', {
    expression: 'globalThis.__pdfReviewLiveMutationObservers',
    returnByValue: true
  })
  writeFileSync(
    testInfo.outputPath('pdf-reload-resource-counts.json'),
    JSON.stringify(
      {
        samples,
        closedWorkers: countWorkers(),
        closedScrollListeners: closedListeners.result.value,
        closedLocalizationObservers: closedObservers.result.value
      },
      null,
      2
    )
  )
  expect(closedObservers.result.value).toBe(0)
  await cdp.detach()
})
