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

const CONTROLLER = 'api/src/main/java/com/acme/web/AboutController.java'

test('Cmd/Ctrl+Click in Java opens a supertype and its inherited method in another module', async ({
  orcaPage,
  testRepoPath,
  registerPostElectronShutdownCleanup
}) => {
  const fixture = createGoldenWorktree(testRepoPath, 'java-definition')
  registerPostElectronShutdownCleanup(async () => cleanupGoldenWorktree(testRepoPath, fixture))
  const write = (relativePath: string, content: string): void => {
    const filePath = path.join(fixture.worktreePath, relativePath)
    mkdirSync(path.dirname(filePath), { recursive: true })
    writeFileSync(filePath, content)
  }
  write(
    CONTROLLER,
    [
      'package com.acme.web;',
      '',
      'import com.acme.core.LocalizedController;',
      '',
      'public class AboutController extends LocalizedController {',
      '    public String index(String model) {',
      '        return localizedView(model, "AboutAgl");',
      '    }',
      '}',
      ''
    ].join('\n')
  )
  write(
    'core/src/main/java/com/acme/core/LocalizedController.java',
    [
      'package com.acme.core;',
      '',
      'public abstract class LocalizedController {',
      '    protected String localizedView(String model, String view) {',
      '        return view;',
      '    }',
      '}',
      ''
    ].join('\n')
  )

  await waitForSessionReady(orcaPage)
  await activateGoldenWorktree(orcaPage, testRepoPath, fixture.worktreePath)
  await openFileExplorer(orcaPage)
  const editorLines = orcaPage.locator('.monaco-editor .view-lines')
  const header = orcaPage.locator('.editor-header-path').first()

  await clickFileInExplorer(orcaPage, [CONTROLLER])
  await expect(editorLines).toContainText('extends LocalizedController', { timeout: 25_000 })
  await modifierClickName(orcaPage, 'public class AboutController', 'LocalizedController')
  await expect(header).toContainText('LocalizedController.java', { timeout: 15_000 })
  await expect.poll(() => editorSelectionLine(orcaPage), { timeout: 10_000 }).toBe(3)

  await clickFileInExplorer(orcaPage, [CONTROLLER])
  await expect(editorLines).toContainText('return localizedView(', { timeout: 25_000 })
  await modifierClickName(orcaPage, 'return localizedView(', 'localizedView')
  await expect(header).toContainText('LocalizedController.java', { timeout: 15_000 })
  await expect.poll(() => editorSelectionLine(orcaPage), { timeout: 10_000 }).toBe(4)
})
