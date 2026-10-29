import path from 'node:path'
import { expect, test } from './helpers/orca-app'

test.describe('floating Markdown filesystem aliases', () => {
  test.skip(process.platform !== 'darwin', 'Requires native APFS alias behavior')

  test('renames one APFS entry through its Unicode alias', async ({ orcaPage }) => {
    const directory = await orcaPage.evaluate(() => window.api.app.getFloatingMarkdownDirectory())
    const suffix = Date.now().toString(36)
    const originalPath = path.join(directory, `floating-alias-${suffix}-straße.md`)
    const renamedPath = path.join(directory, `floating-alias-${suffix}-STRASSE.MD`)
    const renamedName = path.basename(renamedPath)

    const result = await orcaPage.evaluate(
      async ({ directory, originalPath, renamedPath, renamedName }) => {
        await window.api.fs.createFile({ filePath: originalPath })
        await window.api.fs.writeFile({ filePath: originalPath, content: 'same entry\n' })
        const settled = await Promise.allSettled([
          window.api.fs.rename({ oldPath: originalPath, newPath: renamedPath })
        ])
        return {
          status: settled[0].status,
          reason: settled[0].status === 'rejected' ? String(settled[0].reason) : null,
          content: (await window.api.fs.readFile({ filePath: renamedPath })).content,
          renamedEntryExists: (await window.api.fs.readDir({ dirPath: directory })).some(
            ({ name }) => name === renamedName
          )
        }
      },
      { directory, originalPath, renamedPath, renamedName }
    )

    expect(result).toEqual({
      status: 'fulfilled',
      reason: null,
      content: 'same entry\n',
      renamedEntryExists: true
    })
  })

  test('keeps dotless and ASCII I destinations distinct through IPC', async ({ orcaPage }) => {
    const directory = await orcaPage.evaluate(() => window.api.app.getFloatingMarkdownDirectory())
    const suffix = Date.now().toString(36)
    const firstPath = path.join(directory, `floating-dotless-first-${suffix}.md`)
    const secondPath = path.join(directory, `floating-dotless-second-${suffix}.md`)
    const dotlessDestination = path.join(directory, `floating-destination-${suffix}-ı.md`)
    const asciiDestination = path.join(directory, `floating-destination-${suffix}-I.md`)

    const result = await orcaPage.evaluate(
      async ({ firstPath, secondPath, dotlessDestination, asciiDestination }) => {
        await window.api.fs.createFile({ filePath: firstPath })
        await window.api.fs.createFile({ filePath: secondPath })
        await window.api.fs.writeFile({ filePath: firstPath, content: 'dotless\n' })
        await window.api.fs.writeFile({ filePath: secondPath, content: 'ascii\n' })

        const settled = await Promise.allSettled([
          window.api.fs.rename({ oldPath: firstPath, newPath: dotlessDestination }),
          window.api.fs.rename({ oldPath: secondPath, newPath: asciiDestination })
        ])
        return {
          statuses: settled.map(({ status }) => status),
          dotlessContent: (await window.api.fs.readFile({ filePath: dotlessDestination })).content,
          asciiContent: (await window.api.fs.readFile({ filePath: asciiDestination })).content
        }
      },
      { firstPath, secondPath, dotlessDestination, asciiDestination }
    )

    expect(result).toEqual({
      statuses: ['fulfilled', 'fulfilled'],
      dotlessContent: 'dotless\n',
      asciiContent: 'ascii\n'
    })
  })
})
