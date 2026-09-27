import { writeFile } from 'node:fs/promises'
import { test, expect } from './sidebar-animation-fixture'
import { prepareRenameTyping, recordRenameMotion } from './sidebar-rename-readiness-state'
import { worktreeRow } from './worktree-row-locators'

for (const child of [400, 2]) {
  for (const delay of [60, 250, 600]) {
    test(`rename typing reaches child${child} after ${delay}ms`, async ({ orcaPage }, testInfo) => {
      const targetId = `e2e-virtual-child-${child}`
      await prepareRenameTyping(orcaPage, targetId)
      const motion = await recordRenameMotion(orcaPage)
      await orcaPage.keyboard.press('ControlOrMeta+Alt+r')
      await orcaPage.waitForTimeout(delay)
      await orcaPage.keyboard.type('xyz')
      const input = worktreeRow(orcaPage, targetId).getByRole('textbox')
      try {
        await expect(input).toHaveValue('xyz')
        await expect(orcaPage.locator('#rename-typing-terminal')).toHaveValue('')
        await expect(input).toBeFocused()
        await expect
          .poll(() => orcaPage.evaluate(() => window.__store!.getState().pendingRevealWorktree))
          .toBeNull()
        await expect(input).toHaveValue('xyz')
        await expect(input).toBeInViewport()
      } finally {
        const recorded = await motion.evaluate((recording) => recording.finish())
        await writeFile(testInfo.outputPath('motion.json'), JSON.stringify(recorded, null, 2))
        await motion.dispose()
        await writeFile(
          testInfo.outputPath('typing.json'),
          JSON.stringify(
            await orcaPage.evaluate(() => ({
              terminal:
                document.querySelector<HTMLTextAreaElement>('#rename-typing-terminal')?.value,
              draft: document.querySelector<HTMLInputElement>('[data-worktree-title-rename-input]')
                ?.value
            })),
            null,
            2
          )
        )
        await orcaPage.screenshot({ path: testInfo.outputPath('rename.png') })
        const firstInput = recorded.inputs[0]
        expect(firstInput).toBeDefined()
        expect(
          recorded.writes.filter((write) => write.time >= firstInput && write.behavior === 'smooth')
        ).toEqual([])
      }
      await orcaPage.keyboard.press('Escape')
      await expect(input).toHaveCount(0)
    })
  }
}

test('untyped distant rename keeps native motion after early focus', async ({
  orcaPage
}, testInfo) => {
  const targetId = 'e2e-virtual-child-400'
  await prepareRenameTyping(orcaPage, targetId)
  const motion = await recordRenameMotion(orcaPage)
  try {
    await orcaPage.keyboard.press('ControlOrMeta+Alt+r')
    const input = worktreeRow(orcaPage, targetId).getByRole('textbox')
    await expect(input).toBeFocused()
    await expect
      .poll(() => orcaPage.evaluate(() => window.__store!.getState().pendingRevealWorktree))
      .toBeNull()
    await expect(input).toBeInViewport()
    const recorded = await motion.evaluate((recording) => recording.finish())
    await writeFile(testInfo.outputPath('untyped-motion.json'), JSON.stringify(recorded, null, 2))
    expect(recorded.inputs).toEqual([])
    const finalTop = recorded.frames.at(-1)!.top
    const intermediate = recorded.frames.filter((frame) => frame.top > 0 && frame.top < finalTop)
    expect(new Set(intermediate.map((frame) => frame.top)).size).toBeGreaterThan(10)
    const steps = recorded.frames
      .slice(1)
      .map((frame, index) => frame.top - recorded.frames[index].top)
    expect(Math.max(...steps)).toBeLessThan(finalTop / 2)
    await orcaPage.screenshot({ path: testInfo.outputPath('untyped-rename.png') })
  } finally {
    await motion.evaluate((recording) => recording.finish())
    await motion.dispose()
  }
})
