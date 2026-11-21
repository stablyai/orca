import path from 'node:path'

import { test } from '../../desktop/electron-fixtures/orca-app'
import { expect } from '@stablyai/playwright-test'
import '../../desktop/renderer-probes/store'

import '../../desktop/electron-fixtures/orca-restart'

// Mirror FLOATING_TERMINAL_WORKTREE_ID without loading renderer/shared modules into Playwright.

test('concurrent floating Markdown renames do not clobber the destination', async ({
  orcaPage
}) => {
  const directory = await orcaPage.evaluate(() => window.api.app.getFloatingMarkdownDirectory())
  const suffix = Date.now().toString(36)
  const firstPath = path.join(directory, `floating-first-${suffix}.md`)
  const secondPath = path.join(directory, `floating-second-${suffix}.md`)
  const destinationPath = path.join(directory, `floating-destination-${suffix}.md`)

  const result = await orcaPage.evaluate(
    async ({ firstPath, secondPath, destinationPath }) => {
      await window.api.fs.createFile({ filePath: firstPath })
      await window.api.fs.createFile({ filePath: secondPath })
      await window.api.fs.writeFile({ filePath: firstPath, content: 'first\n' })
      await window.api.fs.writeFile({ filePath: secondPath, content: 'second\n' })

      const settled = await Promise.allSettled([
        window.api.fs.rename({ oldPath: firstPath, newPath: destinationPath }),
        window.api.fs.rename({ oldPath: secondPath, newPath: destinationPath })
      ])
      const firstExists = await window.api.fs.pathExists({ filePath: firstPath })
      const secondExists = await window.api.fs.pathExists({ filePath: secondPath })
      return {
        statuses: settled.map(({ status }) => status).sort(),
        rejectionMessages: settled.flatMap((outcome) =>
          outcome.status === 'rejected' ? [String(outcome.reason)] : []
        ),
        destinationContent: (await window.api.fs.readFile({ filePath: destinationPath })).content,
        firstExists,
        secondExists,
        firstContent: firstExists
          ? (await window.api.fs.readFile({ filePath: firstPath })).content
          : null,
        secondContent: secondExists
          ? (await window.api.fs.readFile({ filePath: secondPath })).content
          : null
      }
    },
    { firstPath, secondPath, destinationPath }
  )

  expect(result.statuses).toEqual(['fulfilled', 'rejected'])
  expect(result.rejectionMessages[0]).toContain('already exists')
  expect(Number(result.firstExists) + Number(result.secondExists)).toBe(1)
  expect(
    [result.destinationContent, result.firstContent ?? result.secondContent].toSorted()
  ).toEqual(['first\n', 'second\n'])
})

test('Electron serializes native Unicode rename aliases', async ({ orcaPage }) => {
  test.skip(process.platform !== 'darwin', 'Requires native Unicode aliasing')
  const directory = await orcaPage.evaluate(() => window.api.app.getFloatingMarkdownDirectory())
  const suffix = Date.now().toString(36)
  const firstPath = path.join(directory, `floating-unicode-first-${suffix}.md`)
  const secondPath = path.join(directory, `floating-unicode-second-${suffix}.md`)
  const sharpSDestination = path.join(directory, `floating-destination-${suffix}-straße.md`)
  const expandedDestination = path.join(directory, `floating-destination-${suffix}-STRASSE.MD`)

  const result = await orcaPage.evaluate(
    async ({ firstPath, secondPath, sharpSDestination, expandedDestination }) => {
      await window.api.fs.createFile({ filePath: firstPath })
      await window.api.fs.createFile({ filePath: secondPath })
      await window.api.fs.writeFile({ filePath: firstPath, content: 'first\n' })
      await window.api.fs.writeFile({ filePath: secondPath, content: 'second\n' })

      const settled = await Promise.allSettled([
        window.api.fs.rename({ oldPath: firstPath, newPath: sharpSDestination }),
        window.api.fs.rename({ oldPath: secondPath, newPath: expandedDestination })
      ])
      const firstExists = await window.api.fs.pathExists({ filePath: firstPath })
      const secondExists = await window.api.fs.pathExists({ filePath: secondPath })
      return {
        statuses: settled.map(({ status }) => status).sort(),
        destinationContent: (await window.api.fs.readFile({ filePath: sharpSDestination })).content,
        firstExists,
        secondExists,
        remainingContent: firstExists
          ? (await window.api.fs.readFile({ filePath: firstPath })).content
          : (await window.api.fs.readFile({ filePath: secondPath })).content
      }
    },
    { firstPath, secondPath, sharpSDestination, expandedDestination }
  )

  expect(result.statuses).toEqual(['fulfilled', 'rejected'])
  expect(Number(result.firstExists) + Number(result.secondExists)).toBe(1)
  expect([result.destinationContent, result.remainingContent].toSorted()).toEqual([
    'first\n',
    'second\n'
  ])
})
