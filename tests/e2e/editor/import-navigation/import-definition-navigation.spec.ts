import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect } from '@stablyai/playwright-test'
import { test } from '../../desktop/electron-fixtures/orca-app'
import { waitForSessionReady } from '../../desktop/renderer-probes/store'
import {
  activateGoldenWorktree,
  cleanupGoldenWorktree,
  createGoldenWorktree
} from '../../golden-journeys/golden-source-control'
import { clickFileInExplorer, openFileExplorer } from '../file-explorer/file-explorer'
import { editorSelectionLine, modifierClickName } from './monaco-definition-click'

test('Cmd/Ctrl+Click on an imported name opens the file that declares it', async ({
  orcaPage,
  testRepoPath,
  registerPostElectronShutdownCleanup
}) => {
  const fixture = createGoldenWorktree(testRepoPath, 'import-definition')
  registerPostElectronShutdownCleanup(async () => cleanupGoldenWorktree(testRepoPath, fixture))
  const write = (relativePath: string, content: string): void => {
    const filePath = path.join(fixture.worktreePath, relativePath)
    mkdirSync(path.dirname(filePath), { recursive: true })
    writeFileSync(filePath, content)
  }
  write('tsconfig.json', '{ "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }\n')
  write('src/api.ts', 'export const unrelated = 0\n\nexport function useTrend() {\n  return 1\n}\n')
  write(
    'src/components/Button.tsx',
    'const label = 1\n\nexport default function Button() {\n  return label\n}\n'
  )
  write(
    'src/app.ts',
    "import { useTrend } from './api'\nimport Button from '@/components/Button'\n\nexport const trend = useTrend()\nexport const view = Button\n"
  )

  await waitForSessionReady(orcaPage)
  await activateGoldenWorktree(orcaPage, testRepoPath, fixture.worktreePath)
  await openFileExplorer(orcaPage)
  const editorLines = orcaPage.locator('.monaco-editor .view-lines')

  await clickFileInExplorer(orcaPage, ['src/app.ts'])
  await expect(editorLines).toContainText('export const trend = useTrend()', { timeout: 25_000 })
  await modifierClickName(orcaPage, 'export const trend', 'useTrend')
  await expect(orcaPage.locator('.editor-header-path').first()).toContainText('api.ts', {
    timeout: 15_000
  })
  await expect(editorLines).toContainText('export function useTrend()')
  await expect.poll(() => editorSelectionLine(orcaPage), { timeout: 10_000 }).toBe(3)

  await clickFileInExplorer(orcaPage, ['src/app.ts'])
  await expect(editorLines).toContainText('export const view = Button', { timeout: 25_000 })
  await modifierClickName(orcaPage, 'export const view', 'Button')
  await expect(orcaPage.locator('.editor-header-path').first()).toContainText('Button.tsx', {
    timeout: 15_000
  })
  await expect.poll(() => editorSelectionLine(orcaPage), { timeout: 10_000 }).toBe(3)
})
