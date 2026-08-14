import { execFileSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'
import { openSourceControlForWorktree } from './helpers/worktree-registration'

const subject = 'brew-install: source shared brew context before resolving prefixes'
const reportedLine = 'Sources bin/lib/brew-context.sh, mirroring the brew-install update:'
const conventionalLine = 'Keep this conventional commit-message body line intact through column 72'
const unbrokenLine = `https://example.com/${'commit-message-segment-'.repeat(8)}`
const commitMessage = `${subject}

${reportedLine}
${conventionalLine}
${unbrokenLine}
the resolved prefix list now feeds both the cask audit and the formula
path checks, so a missing context aborts before any network call runs.

Verified by running the full tap audit locally with both prefixes set.`

function createCommitWorktree(repoPath: string): { branchName: string; worktreePath: string } {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
  const branchName = `e2e-tooltip-wrap-${suffix}`
  const worktreePath = path.join(os.tmpdir(), branchName)
  execFileSync('git', ['worktree', 'add', worktreePath, '-b', branchName], {
    cwd: repoPath,
    stdio: 'pipe'
  })
  return { branchName, worktreePath }
}

async function cleanupCommitWorktree(
  repoPath: string,
  worktreePath: string,
  branchName: string
): Promise<void> {
  try {
    execFileSync('git', ['worktree', 'remove', '--force', worktreePath], {
      cwd: repoPath,
      stdio: 'pipe'
    })
  } catch {
    rmSync(worktreePath, { recursive: true, force: true })
    execFileSync('git', ['worktree', 'prune'], { cwd: repoPath, stdio: 'pipe' })
  }
  execFileSync('git', ['branch', '-D', branchName], { cwd: repoPath, stdio: 'pipe' })
}

test('keeps conventional commit-message lines intact in the history tooltip', async ({
  orcaPage,
  testRepoPath,
  registerPostElectronShutdownCleanup
}) => {
  const fixture = createCommitWorktree(testRepoPath)
  registerPostElectronShutdownCleanup(() =>
    cleanupCommitWorktree(testRepoPath, fixture.worktreePath, fixture.branchName)
  )
  execFileSync('git', ['commit', '--allow-empty', '--file', '-'], {
    cwd: fixture.worktreePath,
    input: commitMessage,
    stdio: ['pipe', 'pipe', 'pipe']
  })

  await orcaPage.setViewportSize({ width: 1440, height: 900 })
  await waitForSessionReady(orcaPage)
  await openSourceControlForWorktree(orcaPage, testRepoPath, fixture.worktreePath)

  const commitsToggle = orcaPage.getByRole('button', { name: /Commits/ })
  await expect(commitsToggle).toBeVisible()
  await commitsToggle.click()

  const row = orcaPage.getByTestId('git-history-row').filter({ hasText: subject })
  await expect(row).toBeVisible({ timeout: 10_000 })
  await expect(row).not.toHaveAttribute('title')
  const trigger = row.locator('[data-slot="tooltip-trigger"]').filter({ hasText: subject })
  await expect(trigger).not.toHaveAttribute('title')
  await trigger.hover({ position: { x: 20, y: 10 } })
  await trigger.hover({ position: { x: 40, y: 10 } })

  const tooltip = orcaPage
    .locator('[data-slot="tooltip-content"]')
    .filter({ hasText: reportedLine })
  await expect(tooltip).toBeVisible()
  await expect(tooltip).toContainText(commitMessage)
  await orcaPage.evaluate(async () => {
    await document.fonts.ready
  })

  const layout = await tooltip.evaluate(
    (element, targetLines) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
      let textNode: Text | null = null
      while (walker.nextNode()) {
        const candidate = walker.currentNode as Text
        if (targetLines.every((line) => candidate.data.includes(line))) {
          textNode = candidate
          break
        }
      }
      if (!textNode) {
        throw new Error('Commit message text node was not found in the tooltip')
      }

      const visualLineCounts = targetLines.map((targetLine) => {
        const start = textNode.data.indexOf(targetLine)
        const range = document.createRange()
        range.setStart(textNode, start)
        range.setEnd(textNode, start + targetLine.length)
        const rectTops = Array.from(range.getClientRects())
          .filter((rect) => rect.width > 0.5)
          .map((rect) => rect.top)
        const visualLineTops = rectTops.reduce<number[]>((tops, top) => {
          if (!tops.some((existing) => Math.abs(existing - top) < 2)) {
            tops.push(top)
          }
          return tops
        }, [])
        return visualLineTops.length
      })

      const style = getComputedStyle(element)
      const tooltipRect = element.getBoundingClientRect()
      return {
        visualLineCounts,
        tooltipLeft: tooltipRect.left,
        tooltipRight: tooltipRect.right,
        tooltipWidth: tooltipRect.width,
        viewportWidth: window.innerWidth,
        overflowContained: element.scrollWidth <= element.clientWidth,
        textWrap: style.textWrap,
        whiteSpace: style.whiteSpace
      }
    },
    [reportedLine, conventionalLine]
  )

  expect(layout.whiteSpace).toBe('pre-wrap')
  expect(layout.tooltipWidth).toBeGreaterThan(0)
  expect(layout.tooltipLeft).toBeGreaterThanOrEqual(0)
  expect(layout.tooltipRight).toBeLessThanOrEqual(layout.viewportWidth)
  expect(layout.visualLineCounts).toEqual([1, 1])
  expect(layout.overflowContained).toBe(true)
  expect(layout.textWrap).toBe('wrap')
})
