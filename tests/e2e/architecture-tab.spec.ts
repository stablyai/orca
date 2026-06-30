/* eslint-disable max-lines -- Why: this live suite intentionally exercises the full Orca/Scryer loop: canvas editing, MCP updates, drift, source-map editor opening, sync/cancel, and restart persistence. */
/**
 * Live architecture-tab coverage for the Orca/Scryer integration.
 *
 * This drives the same user path as the app: open New Architecture from the
 * "+" menu, edit the canvas, persist .scryer/planned.scry, call the MCP bridge,
 * and detect drift after code changes under a source-mapped node.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs'
import path from 'path'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import { TEST_REPO_PATH_FILE } from './global-setup'

async function getActiveWorktreePath(
  page: Parameters<typeof waitForSessionReady>[0]
): Promise<string> {
  return page.evaluate(() => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }
    const state = store.getState()
    const worktree = Object.values(state.worktreesByRepo)
      .flat()
      .find((entry) => entry.id === state.activeWorktreeId)
    if (!worktree) {
      throw new Error('active worktree not found')
    }
    return worktree.path
  })
}

async function openArchitectureTab(page: Parameters<typeof waitForSessionReady>[0]): Promise<void> {
  await page.getByRole('button', { name: 'New tab' }).click({ force: true })
  const newArchitectureItem = page.getByRole('menuitem', { name: /New Architecture/i }).first()
  await expect(newArchitectureItem).toBeVisible({ timeout: 10_000 })
  await newArchitectureItem.click({ force: true })
  await expect(newArchitectureItem).toBeHidden({ timeout: 5_000 })
  await expect(page.getByRole('button', { name: /Architecture/ })).toBeVisible({
    timeout: 10_000
  })
  await expect(page.getByTestId('architecture-panel')).toBeVisible({ timeout: 10_000 })
  await closeOpenMenus(page)
}

async function closeOpenMenus(page: Parameters<typeof waitForSessionReady>[0]): Promise<void> {
  const visibleMenus = page.locator('[role="menu"]:visible')
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if ((await visibleMenus.count()) === 0) {
      return
    }
    await page.keyboard.press('Escape')
    await page.waitForTimeout(100)
    if ((await visibleMenus.count()) === 0) {
      return
    }
    await page.getByTestId('architecture-panel').click({ position: { x: 8, y: 8 } })
    await page.waitForTimeout(100)
  }
  await page.keyboard.press('Escape')
  await page.getByTestId('architecture-panel').click({ position: { x: 8, y: 8 } })
  await expect(visibleMenus).toHaveCount(0, { timeout: 2_000 })
}

async function activateArchitectureTab(
  page: Parameters<typeof waitForSessionReady>[0]
): Promise<void> {
  await closeOpenMenus(page)
  await page
    .getByRole('button', { name: /Architecture/ })
    .first()
    .click({ force: true })
  await expect(page.getByTestId('architecture-panel')).toBeVisible({ timeout: 10_000 })
}

async function seedArchitectureModel(
  page: Parameters<typeof waitForSessionReady>[0],
  projectPath: string,
  model: Record<string, unknown>
): Promise<void> {
  const result = await page.evaluate(
    async ({ projectPath: nextProjectPath, nextModel }) => {
      const inputModel = nextModel as {
        nodes?: Record<string, unknown>[]
        links?: Record<string, unknown>[]
        edges?: Record<string, unknown>[]
        groups?: Record<string, unknown>[]
        sourceMap?: Record<string, unknown>
        boundaries?: Record<string, unknown>
      }
      const nodes = (inputModel.nodes ?? []).map((node) => {
        const data = (node.data ?? node) as Record<string, unknown>
        const symbolKind =
          data.kind === 'operation' || data.kind === 'process' || data.kind === 'model'
            ? data.kind
            : null
        const kind = symbolKind !== null ? 'symbol' : data.kind
        return {
          id: String(node.id),
          kind,
          name: String(data.name ?? node.id),
          ...(symbolKind ? { appearance: { symbolKind } } : {}),
          ...(node.parentId ? { parentId: String(node.parentId) } : {}),
          ...(typeof data.external === 'boolean' ? { external: data.external } : {}),
          ...(typeof data.technology === 'string' ? { technology: data.technology } : {}),
          ...(typeof data.description === 'string' ? { description: data.description } : {}),
          ...(Array.isArray(data.properties) ? { properties: data.properties } : {})
        }
      })
      const links = (inputModel.links ?? inputModel.edges ?? []).map((link) => {
        const data = (link.data ?? link) as Record<string, unknown>
        return {
          id: String(link.id),
          src: String(link.src ?? link.source),
          dst: String(link.dst ?? link.target),
          label: String(data.label ?? ''),
          ...(typeof data.method === 'string' ? { method: data.method } : {})
        }
      })
      return window.api.architecture.executeScryerOperation({
        projectPath: nextProjectPath,
        operationId: 'scryer.model.set',
        input: {
          data: {
            version: '0.3',
            nodes,
            links,
            groups: inputModel.groups ?? [],
            sourceMap: inputModel.sourceMap ?? {},
            boundaries: inputModel.boundaries ?? {}
          }
        }
      })
    },
    { projectPath, nextModel: model }
  )

  expect(result).toMatchObject({ ok: true })
}

async function seedEngineArchitectureModel(
  page: Parameters<typeof waitForSessionReady>[0],
  projectPath: string,
  model: Record<string, unknown>
): Promise<void> {
  await seedArchitectureModel(page, projectPath, model)
}

async function selectTreeNode(
  page: Parameters<typeof waitForSessionReady>[0],
  name: string
): Promise<void> {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const treeButton = page.getByRole('button', { name: new RegExp(`^${escapedName}\\b`) }).first()
  await expect(treeButton).toBeVisible({ timeout: 10_000 })
  await treeButton.click({ force: true })
}

test.describe('Architecture tab live Scryer sync', () => {
  test.describe.configure({ mode: 'serial' })

  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
  })

  test('keeps the Architecture tab on the canonical default model from the command palette', async ({
    orcaPage
  }) => {
    const worktreePath = await getActiveWorktreePath(orcaPage)
    rmSync(path.join(worktreePath, '.scryer'), { recursive: true, force: true })

    await openArchitectureTab(orcaPage)
    await expect(orcaPage.getByTestId('architecture-active-model')).toHaveText('model.scry')

    await orcaPage.getByTestId('architecture-command-open').click({ force: true })
    await expect(orcaPage.getByTestId('architecture-command-palette')).toBeVisible({
      timeout: 10_000
    })
    await orcaPage.getByTestId('architecture-command-input').fill('arcade')
    await expect(orcaPage.getByTestId('architecture-command-palette')).toBeVisible()
    await orcaPage.keyboard.press('Escape')
    await expect(orcaPage.getByTestId('architecture-active-model')).toHaveText('model.scry')
    await expect
      .poll(() => existsSync(path.join(worktreePath, '.scryer', 'arcade.scry')))
      .toBe(false)
  })

  test('launches agent terminals from Build with AI and Fill with AI', async ({ orcaPage }) => {
    const worktreePath = await getActiveWorktreePath(orcaPage)
    rmSync(path.join(worktreePath, '.scryer'), { recursive: true, force: true })
    await orcaPage.evaluate(() => {
      window.__store?.setState((state) => ({
        settings: {
          ...state.settings,
          defaultTuiAgent: 'codex',
          agentCmdOverrides: {
            ...state.settings?.agentCmdOverrides,
            codex: 'node -e "setTimeout(()=>process.exit(0),60000)"'
          }
        }
      }))
    })

    await openArchitectureTab(orcaPage)
    await expect(orcaPage.getByTestId('architecture-build-ai')).toBeVisible({ timeout: 10_000 })
    await orcaPage.getByTestId('architecture-build-ai').click({ force: true })
    await expect(orcaPage.locator('.xterm:visible').first()).toBeVisible({ timeout: 10_000 })

    await activateArchitectureTab(orcaPage)
    await seedArchitectureModel(orcaPage, worktreePath, {
      nodes: [
        { id: 'system', data: { name: 'Shop', description: 'Commerce system', kind: 'system' } }
      ]
    })
    await activateArchitectureTab(orcaPage)
    const shopTreeNode = orcaPage.getByTestId('architecture-tree-node').filter({ hasText: 'Shop' })
    await expect(shopTreeNode).toBeVisible({ timeout: 10_000 })
    await shopTreeNode.getByTestId('architecture-tree-drill-node').click({ force: true })
    await expect(orcaPage.getByTestId('architecture-fill-ai')).toBeVisible({ timeout: 10_000 })

    await orcaPage.getByTestId('architecture-fill-ai').click({ force: true })
    await expect(orcaPage.locator('.xterm:visible').first()).toBeVisible({ timeout: 10_000 })
  })

  test('loads strict Scryer nodes without legacy status or contract fields', async ({
    orcaPage
  }) => {
    const worktreePath = await getActiveWorktreePath(orcaPage)
    rmSync(path.join(worktreePath, '.scryer'), { recursive: true, force: true })

    await seedArchitectureModel(orcaPage, worktreePath, {
      nodes: [
        {
          id: 'system',
          data: { name: 'Shop', description: 'Commerce system', kind: 'system' }
        }
      ]
    })
    await openArchitectureTab(orcaPage)
    await expect(orcaPage.getByTestId('architecture-node-name')).toHaveValue('Shop')

    await expect
      .poll(() => {
        const saved = JSON.parse(
          readFileSync(path.join(worktreePath, '.scryer', 'model.scry'), 'utf8')
        )
        const system = saved.nodes.find((node: { id: string }) => node.id === 'system')
        return {
          status: system?.status,
          statusReason: system?.statusReason,
          contract: system?.contract
        }
      })
      .toMatchObject({
        status: undefined,
        statusReason: undefined,
        contract: undefined
      })
  })

  test('customizes theme, uses tree navigation, edits mentions and source-map rows, and opens canvas controls', async ({
    orcaPage
  }) => {
    const worktreePath = await getActiveWorktreePath(orcaPage)
    rmSync(path.join(worktreePath, '.scryer'), { recursive: true, force: true })
    await openArchitectureTab(orcaPage)
    await seedArchitectureModel(orcaPage, worktreePath, {
      nodes: [
        {
          id: 'system',
          type: 'c4',
          data: { name: 'Shop', description: 'Commerce system', kind: 'system' }
        },
        {
          id: 'api',
          parentId: 'system',
          type: 'c4',
          data: { name: 'API', description: 'HTTP API', kind: 'container' }
        },
        {
          id: 'worker',
          parentId: 'system',
          type: 'c4',
          data: { name: 'Worker', description: 'Background jobs', kind: 'container' }
        },
        {
          id: 'order-schema',
          parentId: 'api',
          type: 'model',
          data: {
            name: 'Order',
            description: 'Order payload',
            kind: 'model',
            properties: [{ label: 'id', description: 'Order identifier' }]
          }
        }
      ],
      links: [],
      sourceMap: {},
      projectPath: worktreePath
    })

    await expect(
      orcaPage.getByTestId('architecture-tree-node').filter({ hasText: 'API' })
    ).toBeVisible({ timeout: 10_000 })

    await orcaPage.getByTestId('architecture-theme-open').click({ force: true })
    await orcaPage.getByTestId('architecture-theme-mode').selectOption('dark')
    await orcaPage.getByTestId('architecture-theme-node-fill').fill('#123456')
    await expect
      .poll(() =>
        orcaPage.evaluate(() => window.localStorage.getItem('orca-scryer:architecture-theme'))
      )
      .toContain('"nodeFill":"#123456"')
    await orcaPage.getByTestId('architecture-theme-open').click({ force: true })

    await selectTreeNode(orcaPage, 'API')
    await expect(orcaPage.getByTestId('architecture-node-name')).toHaveValue('API')
    await orcaPage.getByTestId('architecture-node-description').fill('Calls @')
    await expect(orcaPage.getByTestId('architecture-mention-dropdown')).toBeVisible({
      timeout: 10_000
    })
    await orcaPage
      .getByTestId('architecture-mention-option')
      .filter({ hasText: 'Worker' })
      .first()
      .click({ force: true })
    await orcaPage.getByTestId('architecture-node-name').click({ force: true })
    await expect(orcaPage.getByTestId('architecture-mention-warning')).toContainText('Worker')

    await orcaPage.getByTestId('architecture-source-add').click({ force: true })
    await orcaPage.getByTestId('architecture-source-pattern-row').last().fill('src/api.ts')
    await orcaPage.getByTestId('architecture-source-line-row').last().fill('3')
    await orcaPage.getByTestId('architecture-source-end-line-row').last().fill('8')
    await orcaPage.getByTestId('architecture-source-command-row').last().fill('npm test')
    await orcaPage.getByTestId('architecture-source-save').click({ force: true })
    await expect
      .poll(() => {
        const saved = JSON.parse(
          readFileSync(path.join(worktreePath, '.scryer', 'model.scry'), 'utf8')
        )
        return saved.boundaries?.api?.[0]
      })
      .toMatchObject({ pattern: 'src/api.ts', comment: 'npm test' })

    await selectTreeNode(orcaPage, 'Order')
    await orcaPage.getByTestId('architecture-source-add').click({ force: true })
    await orcaPage.getByTestId('architecture-source-pattern-row').last().fill('src/order.ts')
    await orcaPage.getByTestId('architecture-source-line-row').last().fill('10')
    await orcaPage.getByTestId('architecture-source-end-line-row').last().fill('20')
    await orcaPage.getByTestId('architecture-source-command-row').last().fill('pnpm test order')
    await orcaPage.getByTestId('architecture-source-save').click({ force: true })
    await expect
      .poll(() => {
        const saved = JSON.parse(
          readFileSync(path.join(worktreePath, '.scryer', 'model.scry'), 'utf8')
        )
        return saved.sourceMap?.['order-schema']?.[0]
      })
      .toMatchObject({
        pattern: 'src/order.ts',
        line: 10,
        endLine: 20,
        command: 'pnpm test order'
      })

    const canvasPane = orcaPage.locator('.react-flow__pane')
    const canvasPaneBox = await canvasPane.boundingBox()
    expect(canvasPaneBox).not.toBeNull()
    await orcaPage.mouse.click(
      canvasPaneBox!.x + 30,
      canvasPaneBox!.y + Math.max(30, canvasPaneBox!.height - 30),
      { button: 'right' }
    )
    await expect(orcaPage.getByTestId('architecture-canvas-context-menu')).toBeVisible()
    await orcaPage.getByTestId('architecture-context-add-node').click({ force: true })
    await expect
      .poll(() => {
        const saved = JSON.parse(
          readFileSync(path.join(worktreePath, '.scryer', 'planned.scry'), 'utf8')
        )
        return {
          nodeCount: saved.nodes.length,
          addedNode: saved.nodes.find((node) => node.name === 'Component 1')
        }
      })
      .toMatchObject({
        nodeCount: 5,
        addedNode: { kind: 'component', parentId: 'api' }
      })
    await expect(orcaPage.getByTestId('architecture-zoom-fit')).toBeVisible()
    await orcaPage.getByTestId('architecture-zoom-fit').click({ force: true })
  })

  test('launches advisor review and allows manually setting person shape', async ({ orcaPage }) => {
    const worktreePath = await getActiveWorktreePath(orcaPage)
    rmSync(path.join(worktreePath, '.scryer'), { recursive: true, force: true })
    await orcaPage.evaluate(() => {
      window.__store?.setState((state) => ({
        settings: {
          ...state.settings,
          defaultTuiAgent: 'codex',
          agentCmdOverrides: {
            ...state.settings?.agentCmdOverrides,
            codex: 'node -e "setTimeout(()=>process.exit(0),5000)"'
          }
        }
      }))
    })

    await openArchitectureTab(orcaPage)
    await seedArchitectureModel(orcaPage, worktreePath, {
      nodes: [
        {
          id: 'system',
          type: 'c4',
          data: { name: 'Shop', description: 'Commerce system', kind: 'system' }
        },
        {
          id: 'api',
          parentId: 'system',
          type: 'c4',
          data: { name: 'API', description: 'HTTP API', kind: 'container' }
        }
      ],
      links: [],
      sourceMap: {},
      projectPath: worktreePath
    })

    await expect(
      orcaPage.getByTestId('architecture-tree-node').filter({ hasText: 'API' })
    ).toBeVisible({ timeout: 10_000 })
    await orcaPage.getByTestId('architecture-advisor-review').click({ force: true })
    await expect(orcaPage.locator('.xterm:visible').first()).toBeVisible({ timeout: 10_000 })

    await activateArchitectureTab(orcaPage)
    await selectTreeNode(orcaPage, 'API')
    await orcaPage.getByTestId('architecture-node-shape-select').selectOption('person')
    await expect
      .poll(() => {
        const saved = JSON.parse(
          readFileSync(path.join(worktreePath, '.scryer', 'model.scry'), 'utf8')
        )
        return saved.nodes.find((node: { id: string; shape?: string }) => node.id === 'api')?.shape
      })
      .toBeUndefined()
  })

  test('batches rapid model edits into one undo and redo step', async ({ orcaPage }) => {
    const worktreePath = await getActiveWorktreePath(orcaPage)
    rmSync(path.join(worktreePath, '.scryer'), { recursive: true, force: true })

    await openArchitectureTab(orcaPage)
    await orcaPage.getByTestId('architecture-add-node').click({ force: true })
    const nameInput = orcaPage.getByTestId('architecture-node-name')
    await expect(nameInput).toHaveValue('System 1')

    await orcaPage.waitForTimeout(1_100)
    await nameInput.fill('Shop System')
    await orcaPage.keyboard.press('Tab')
    await orcaPage.getByTestId('architecture-source-pattern').fill('src/**/*.ts')
    await orcaPage.keyboard.press('Tab')
    await expect(nameInput).toHaveValue('Shop System')
    await expect(orcaPage.getByTestId('architecture-source-pattern')).toHaveValue('src/**/*.ts')

    await orcaPage.getByTestId('architecture-undo').click({ force: true })
    await expect(nameInput).toHaveValue('System 1')
    await expect(orcaPage.getByTestId('architecture-source-pattern')).toHaveValue('')

    await orcaPage.getByTestId('architecture-redo').click({ force: true })
    await expect(nameInput).toHaveValue('Shop System')
    await expect(orcaPage.getByTestId('architecture-source-pattern')).toHaveValue('src/**/*.ts')

    await expect
      .poll(() => {
        const saved = JSON.parse(
          readFileSync(path.join(worktreePath, '.scryer', 'planned.scry'), 'utf8')
        )
        const node = saved.nodes.find(
          (candidate: { name?: string }) => candidate.name === 'Shop System'
        )
        return node ? saved.boundaries?.[node.id]?.[0]?.pattern : null
      })
      .toBe('src/**/*.ts')
  })

  test('edits the visual model, persists planned.scry, syncs MCP updates, and detects code drift', async ({
    orcaPage
  }) => {
    const worktreePath = await getActiveWorktreePath(orcaPage)
    rmSync(path.join(worktreePath, '.scryer'), { recursive: true, force: true })

    await openArchitectureTab(orcaPage)

    await orcaPage.getByTestId('architecture-add-node').click({ force: true })
    await expect(
      orcaPage.getByTestId('architecture-tree-node').filter({ hasText: 'System 1' })
    ).toBeVisible()

    const nameInput = orcaPage.getByTestId('architecture-node-name')
    await expect(nameInput).toHaveValue('System 1')
    await nameInput.fill('Shop System')
    await orcaPage.keyboard.press('Tab')
    await expect(
      orcaPage.getByTestId('architecture-tree-node').filter({ hasText: 'Shop System' })
    ).toBeVisible()

    await orcaPage.getByTestId('architecture-add-node').click({ force: true })
    await expect(nameInput).toHaveValue('Container 1')
    await nameInput.fill('API Container')
    await orcaPage.keyboard.press('Tab')
    await expect(
      orcaPage.getByTestId('architecture-tree-node').filter({ hasText: 'API Container' })
    ).toBeVisible()
    await expect(orcaPage.getByTestId('architecture-node-shape-select')).toBeVisible()

    await orcaPage.getByTestId('architecture-source-pattern').fill('src/**/*.ts')
    await orcaPage.keyboard.press('Tab')

    await orcaPage.getByTestId('architecture-canvas-add-node').click({ force: true })
    await expect(nameInput).toHaveValue('Container 2')
    await nameInput.fill('Worker Container')
    await orcaPage.keyboard.press('Tab')
    await orcaPage.getByTestId('architecture-edge-target').selectOption({ label: 'API Container' })
    await orcaPage.getByTestId('architecture-add-edge').click({ force: true })
    await expect
      .poll(() => {
        const saved = JSON.parse(
          readFileSync(path.join(worktreePath, '.scryer', 'planned.scry'), 'utf8')
        )
        return saved.links[0]?.label
      })
      .toBe('depends on')
    await expect(orcaPage.locator('.react-flow__minimap')).toHaveCount(0)
    await expect(orcaPage.locator('.react-flow__controls')).toHaveCount(0)

    await expect
      .poll(() => {
        const saved = JSON.parse(
          readFileSync(path.join(worktreePath, '.scryer', 'planned.scry'), 'utf8')
        )
        return saved.links[0]?.id ?? null
      })
      .not.toBeNull()
    const edgeId = JSON.parse(
      readFileSync(path.join(worktreePath, '.scryer', 'planned.scry'), 'utf8')
    ).links[0].id as string
    await selectTreeNode(orcaPage, 'Worker Container')
    const existingEdge = orcaPage
      .getByTestId('architecture-existing-edge')
      .filter({ hasText: 'depends on' })
      .first()
    await expect(existingEdge).toBeVisible({ timeout: 10_000 })
    await existingEdge.click({ force: true })
    await expect(orcaPage.getByTestId('architecture-edge-editor')).toBeVisible({
      timeout: 10_000
    })
    await orcaPage.getByTestId('architecture-edge-label-input').fill('publishes event')
    await expect
      .poll(() => {
        const saved = JSON.parse(
          readFileSync(path.join(worktreePath, '.scryer', 'planned.scry'), 'utf8')
        )
        return saved.links.find((link: { id?: string }) => link.id === edgeId)?.label
      })
      .toBe('publishes event')
    const updatedExistingEdge = orcaPage
      .getByTestId('architecture-existing-edge')
      .filter({ hasText: 'publishes event' })
      .first()
    await expect(updatedExistingEdge).toBeVisible({ timeout: 10_000 })
    await updatedExistingEdge.click({ force: true })
    await expect(orcaPage.getByTestId('architecture-edge-editor')).toBeVisible({
      timeout: 10_000
    })
    await orcaPage.getByTestId('architecture-edge-method-input').fill('HTTP')
    await expect
      .poll(() => {
        const saved = JSON.parse(
          readFileSync(path.join(worktreePath, '.scryer', 'planned.scry'), 'utf8')
        )
        return saved.links.find((link: { id?: string }) => link.id === edgeId)
      })
      .toMatchObject({ label: 'publishes event', method: 'HTTP' })
    await orcaPage
      .getByTestId('architecture-existing-edge')
      .filter({ hasText: 'HTTP' })
      .first()
      .click({ force: true })
    await orcaPage.getByTestId('architecture-edge-delete').click({ force: true })
    await expect
      .poll(() => {
        const saved = JSON.parse(
          readFileSync(path.join(worktreePath, '.scryer', 'planned.scry'), 'utf8')
        )
        return saved.links.some((link: { id?: string }) => link.id === edgeId)
      })
      .toBe(false)

    await selectTreeNode(orcaPage, 'Worker Container')
    await orcaPage.getByTestId('architecture-node-delete').click({ force: true })
    await expect
      .poll(() => {
        const saved = JSON.parse(
          readFileSync(path.join(worktreePath, '.scryer', 'planned.scry'), 'utf8')
        )
        return saved.nodes.some((node: { name?: string }) => node.name === 'Worker Container')
      })
      .toBe(false)
    await expect(
      orcaPage.getByTestId('architecture-tree-node').filter({ hasText: 'Worker Container' })
    ).toHaveCount(0)

    await expect(orcaPage.getByTestId('architecture-zoom-fit')).toBeVisible()
    await orcaPage.getByTestId('architecture-zoom-fit').click({ force: true })

    const modelPath = path.join(worktreePath, '.scryer', 'planned.scry')
    await expect.poll(() => existsSync(modelPath), { timeout: 5_000 }).toBe(true)
    await expect
      .poll(
        () => {
          const saved = JSON.parse(readFileSync(modelPath, 'utf8'))
          const node = saved.nodes.find(
            (candidate: { name?: string }) => candidate.name === 'API Container'
          )
          return node && saved.boundaries?.[node.id]?.[0]?.pattern === 'src/**/*.ts'
        },
        {
          timeout: 5_000,
          message: 'architecture tab did not persist the edited node name and source map'
        }
      )
      .toBeTruthy()
    const savedAfterCanvas = JSON.parse(readFileSync(modelPath, 'utf8'))
    const api = savedAfterCanvas.nodes.find(
      (node: { name?: string }) => node.name === 'API Container'
    )
    expect(api).toBeTruthy()
    const apiId = (api as { id: string }).id
    expect(savedAfterCanvas.boundaries?.[apiId]).toEqual([{ pattern: 'src/**/*.ts' }])

    const mcpResult = await orcaPage.evaluate(
      async ({ projectPath, nodeId }) => {
        return window.api.architecture.callTool({
          projectPath,
          call: {
            toolName: 'update_nodes',
            arguments: {
              nodes: [
                {
                  node_id: nodeId,
                  description: 'Updated through architecture MCP bridge'
                }
              ]
            }
          }
        })
      },
      { projectPath: worktreePath, nodeId: apiId }
    )
    expect(mcpResult.ok, JSON.stringify(mcpResult)).toBe(true)
    await selectTreeNode(orcaPage, 'API Container')
    await expect(orcaPage.getByTestId('architecture-node-description')).toHaveValue(
      'Updated through architecture MCP bridge',
      { timeout: 10_000 }
    )
    await expect(orcaPage.getByTestId('architecture-node-diff')).toBeVisible({ timeout: 10_000 })
    await expect(orcaPage.getByTestId('architecture-node-diff')).toContainText('description')
    await expect(orcaPage.getByTestId('architecture-node-diff')).toContainText(
      'Updated through architecture MCP bridge'
    )
    await closeOpenMenus(orcaPage)
    const dismissBox = await orcaPage.getByTestId('architecture-node-diff-dismiss').boundingBox()
    expect(dismissBox).not.toBeNull()
    await orcaPage.mouse.click(
      dismissBox!.x + dismissBox!.width / 2,
      dismissBox!.y + dismissBox!.height / 2
    )
    await expect(orcaPage.getByTestId('architecture-node-diff')).toHaveCount(0)

    await orcaPage.evaluate(
      (projectPath) => window.api.architecture.markSynced({ projectPath }),
      worktreePath
    )
    await orcaPage.waitForTimeout(100)
    await orcaPage.evaluate(async (projectPath) => {
      const separator = projectPath.includes('\\') ? '\\' : '/'
      await window.api.fs.writeFile({
        filePath: `${projectPath}${separator}src${separator}index.ts`,
        content: 'export const hello = "architecture-drift-live-test"\\n'
      })
    }, worktreePath)

    const directDrift = await orcaPage.evaluate(
      (projectPath) => window.api.architecture.checkDrift({ projectPath }),
      worktreePath
    )
    expect(directDrift.nodes, JSON.stringify(directDrift)).toHaveLength(1)

    await orcaPage.getByTestId('architecture-sync-drift').click({ force: true })
    const driftReport = orcaPage.getByTestId('architecture-drift-report')
    await expect(driftReport).toBeVisible({ timeout: 10_000 })
    await expect(driftReport).toContainText('API Container')
    await expect(driftReport).toContainText('src/**/*.ts')

    await orcaPage.getByTestId('architecture-sync-dismiss').click({ force: true })
    await expect(orcaPage.getByText('Marked architecture as synced')).toBeVisible({
      timeout: 10_000
    })
    await orcaPage.waitForTimeout(5500)
    await expect(orcaPage.getByText('Marked architecture as synced')).toHaveCount(0)
  })

  test('does not expose legacy flow editing and rejects flow fields in Scryer 0.3 models', async ({
    orcaPage
  }) => {
    const worktreePath = await getActiveWorktreePath(orcaPage)
    rmSync(path.join(worktreePath, '.scryer'), { recursive: true, force: true })

    await seedArchitectureModel(orcaPage, worktreePath, {
      nodes: [
        {
          id: 'system',
          type: 'c4',
          data: {
            name: 'Shop',
            description: 'Commerce system',
            kind: 'system'
          }
        },
        {
          id: 'api',
          parentId: 'system',
          type: 'c4',
          position: { x: 0, y: 0 },
          data: {
            name: 'API',
            description: 'HTTP boundary',
            kind: 'container',
            status: 'implemented'
          }
        }
      ],
      links: [],
      sourceMap: {},
      groups: []
    })

    await openArchitectureTab(orcaPage)
    await expect(orcaPage.getByTestId('architecture-mode-flows')).toHaveCount(0)
    await expect(orcaPage.getByTestId('architecture-flow-editor')).toHaveCount(0)

    const result = await orcaPage.evaluate(async (projectPath) => {
      return window.api.architecture.executeScryerOperation({
        projectPath,
        operationId: 'scryer.model.set',
        input: {
          data: {
            version: '0.3',
            nodes: [],
            links: [],
            groups: [],
            sourceMap: {},
            boundaries: {},
            flows: []
          }
        }
      })
    }, worktreePath)
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'incompatible_model',
        details: expect.objectContaining({ reason: 'unknown_fields' })
      }
    })

    writeFileSync(
      path.join(worktreePath, '.scryer', 'planned.scry'),
      JSON.stringify(
        {
          version: '0.3',
          nodes: [],
          links: [],
          groups: [],
          sourceMap: {},
          boundaries: {},
          flows: []
        },
        null,
        2
      )
    )
    await orcaPage.getByRole('button', { name: /Reload/i }).click({ force: true })
    await expect(orcaPage.getByTestId('architecture-error')).toContainText(
      'Scryer model contains unsupported fields',
      { timeout: 10_000 }
    )
  })

  test('opens groups view, moves members between groups, and nests groups by drag and drop', async ({
    orcaPage
  }) => {
    const worktreePath = await getActiveWorktreePath(orcaPage)
    rmSync(path.join(worktreePath, '.scryer'), { recursive: true, force: true })

    await seedArchitectureModel(orcaPage, worktreePath, {
      nodes: [
        {
          id: 'system',
          data: { name: 'Shop', description: 'Commerce system', kind: 'system' }
        },
        {
          id: 'api',
          parentId: 'system',
          data: { name: 'API', description: 'HTTP boundary', kind: 'container' }
        },
        {
          id: 'worker',
          parentId: 'system',
          data: { name: 'Worker', description: 'Background jobs', kind: 'container' }
        }
      ],
      links: [],
      sourceMap: {},
      groups: []
    })
    await openArchitectureTab(orcaPage)
    type PlannedGroup = {
      id: string
      name?: string
      description?: string
      memberIds?: string[]
      parentGroupId?: string
      parentNodeId?: string | null
    }
    const readPlannedGroups = (): PlannedGroup[] => {
      const planned = JSON.parse(
        readFileSync(path.join(worktreePath, '.scryer', 'planned.scry'), 'utf8')
      ) as { groups?: PlannedGroup[] }
      return planned.groups ?? []
    }

    const shopTreeNode = orcaPage.getByTestId('architecture-tree-node').filter({ hasText: 'Shop' })
    await expect(shopTreeNode).toBeVisible({ timeout: 10_000 })
    await shopTreeNode.getByTestId('architecture-tree-drill-node').click({ force: true })
    await expect(
      orcaPage.getByTestId('architecture-tree-node').filter({ hasText: 'API' })
    ).toBeVisible({ timeout: 10_000 })
    await orcaPage.getByTestId('architecture-mode-groups').click({ force: true })

    await expect(orcaPage.getByTestId('architecture-groups-main')).toBeVisible({ timeout: 10_000 })
    await expect(orcaPage.getByTestId('architecture-groups-palette')).toBeVisible({
      timeout: 10_000
    })

    await orcaPage.getByTestId('architecture-group-create').click({ force: true })
    await expect(orcaPage.getByTestId('architecture-group-card')).toHaveCount(1)
    const backendCard = orcaPage.getByTestId('architecture-group-card').first()
    await expect(backendCard.getByTestId('architecture-group-name')).toHaveValue('New group')
    await backendCard.getByTestId('architecture-group-name').fill('Backend')

    const apiPaletteItem = orcaPage
      .getByTestId('architecture-groups-palette-item')
      .filter({ hasText: 'API' })
      .first()
    const apiBox = await apiPaletteItem.boundingBox()
    const backendBox = await backendCard.boundingBox()
    expect(apiBox).not.toBeNull()
    expect(backendBox).not.toBeNull()
    await orcaPage.mouse.move(apiBox!.x + apiBox!.width / 2, apiBox!.y + apiBox!.height / 2)
    await orcaPage.mouse.down()
    await orcaPage.mouse.move(
      backendBox!.x + backendBox!.width / 2,
      backendBox!.y + backendBox!.height / 2,
      { steps: 12 }
    )
    await orcaPage.mouse.up()

    await expect
      .poll(
        () => {
          const backend = readPlannedGroups().find((group) => group.name === 'Backend')
          return backend?.memberIds ?? []
        },
        { timeout: 10_000 }
      )
      .toEqual(['api'])

    const groupsBeforePlatform = readPlannedGroups()
    await orcaPage.evaluate(
      async ({ projectPath, groups }) => {
        await window.api.architecture.executeScryerOperation({
          projectPath,
          operationId: 'scryer.group.set',
          input: {
            data: [
              ...groups,
              {
                id: 'group-platform-e2e',
                name: 'New group',
                parentNodeId: 'system',
                memberIds: []
              }
            ]
          }
        })
      },
      { projectPath: worktreePath, groups: groupsBeforePlatform }
    )
    await expect(orcaPage.getByTestId('architecture-group-card')).toHaveCount(2)
    const platformCard = orcaPage.getByTestId('architecture-group-card').last()
    await expect(platformCard.getByTestId('architecture-group-name')).toHaveValue('New group')
    await platformCard.getByTestId('architecture-group-name').fill('Platform')
    await expect
      .poll(
        () =>
          readPlannedGroups()
            .map((group) => group.name)
            .sort(),
        { timeout: 10_000 }
      )
      .toEqual(['Backend', 'Platform'])

    const backendBeforeDescription = readPlannedGroups().find((group) => group.name === 'Backend')
    if (!backendBeforeDescription) {
      throw new Error('Expected Backend group before editing description')
    }
    const backendCardById = orcaPage.locator(
      `[data-testid="architecture-group-card"][data-group-id="${backendBeforeDescription.id}"]`
    )
    await backendCardById
      .getByPlaceholder('What does this group represent?')
      .fill('Runtime services owned by the platform team')
    await expect(backendCardById.getByPlaceholder('What does this group represent?')).toHaveValue(
      'Runtime services owned by the platform team'
    )
    await expect
      .poll(() => readPlannedGroups().find((group) => group.name === 'Backend')?.description, {
        timeout: 10_000
      })
      .toBe('Runtime services owned by the platform team')

    const groupsBeforeNesting = readPlannedGroups()
    const backendBeforeNesting = groupsBeforeNesting.find((group) => group.name === 'Backend')
    const platformBeforeNesting = groupsBeforeNesting.find((group) => group.name === 'Platform')
    if (!backendBeforeNesting || !platformBeforeNesting) {
      throw new Error('Expected Backend and Platform groups before nesting')
    }
    await orcaPage.evaluate(
      async ({ projectPath, groups, backendId, platformId }) => {
        await window.api.architecture.executeScryerOperation({
          projectPath,
          operationId: 'scryer.group.set',
          input: {
            data: groups.map((group) =>
              group.id === backendId ? { ...group, parentGroupId: platformId } : group
            )
          }
        })
      },
      {
        projectPath: worktreePath,
        groups: groupsBeforeNesting,
        backendId: backendBeforeNesting.id,
        platformId: platformBeforeNesting.id
      }
    )

    await expect
      .poll(
        () => {
          const groups = readPlannedGroups()
          const backend = groups.find((group) => group.name === 'Backend')
          const platform = groups.find((group) => group.name === 'Platform')
          return {
            backendMembers: backend?.memberIds ?? [],
            backendParent: backend?.parentGroupId,
            platformMembers: platform?.memberIds ?? []
          }
        },
        { timeout: 10_000 }
      )
      .toMatchObject({
        backendMembers: ['api'],
        backendParent: platformBeforeNesting.id,
        platformMembers: []
      })

    const backendBeforeClear = readPlannedGroups().find((group) => group.name === 'Backend')
    if (!backendBeforeClear) {
      throw new Error('Expected Backend group before clearing members')
    }
    const backendCardBeforeClear = orcaPage.locator(
      `[data-testid="architecture-group-card"][data-group-id="${backendBeforeClear.id}"]`
    )
    await backendCardBeforeClear.locator('[data-node-id="api"]').hover({ force: true })
    await backendCardBeforeClear.getByTestId('architecture-group-member-remove').click({
      force: true
    })

    await expect
      .poll(() => readPlannedGroups().find((group) => group.name === 'Backend')?.memberIds ?? [], {
        timeout: 10_000
      })
      .toEqual([])
    await expect(
      orcaPage.getByTestId('architecture-groups-palette-item').filter({ hasText: 'API' })
    ).toBeVisible()

    await orcaPage.evaluate(async (projectPath) => {
      await window.api.architecture.executeScryerOperation({
        projectPath,
        operationId: 'scryer.group.add',
        input: { items: [{ parent_id: 'system', name: 'Runtime', member_ids: ['api', 'worker'] }] }
      })
    }, worktreePath)
    await expect
      .poll(
        () => {
          const runtime = readPlannedGroups().find((group) => group.name === 'Runtime')
          return runtime?.memberIds?.sort() ?? []
        },
        { timeout: 10_000 }
      )
      .toEqual(['api', 'worker'])

    const runtimeBeforeDelete = readPlannedGroups().find((group) => group.name === 'Runtime')
    if (!runtimeBeforeDelete) {
      throw new Error('Expected Runtime group before deleting it')
    }
    const runtimeCard = orcaPage.locator(
      `[data-testid="architecture-group-card"][data-group-id="${runtimeBeforeDelete.id}"]`
    )
    const runtimeCardBox = await runtimeCard.boundingBox()
    expect(runtimeCardBox).not.toBeNull()
    await orcaPage.mouse.click(runtimeCardBox!.x + 28, runtimeCardBox!.y + 16)
    await expect(orcaPage.getByTestId('architecture-selected-group-editor')).toBeVisible({
      timeout: 10_000
    })
    await expect(orcaPage.getByTestId('architecture-selected-group-name')).toHaveValue('Runtime')
    await orcaPage.getByTestId('architecture-selected-group-delete').click({ force: true })
    await expect
      .poll(() => readPlannedGroups().some((group) => group.id === runtimeBeforeDelete.id), {
        timeout: 10_000
      })
      .toBe(false)
    await expect(runtimeCard).toHaveCount(0)
  })

  test('opens source-map files in the Orca editor and restores the pre-sync model on cancel', async ({
    orcaPage
  }) => {
    const worktreePath = await getActiveWorktreePath(orcaPage)
    rmSync(path.join(worktreePath, '.scryer'), { recursive: true, force: true })
    type ActiveScryModel = {
      nodes?: { id?: string; name?: string }[]
      boundaries?: Record<string, { pattern?: string }[]>
    }
    const readActiveScryModel = (): ActiveScryModel => {
      const plannedPath = path.join(worktreePath, '.scryer', 'planned.scry')
      const modelPath = path.join(worktreePath, '.scryer', 'model.scry')
      const activePath = existsSync(plannedPath) ? plannedPath : modelPath
      return JSON.parse(readFileSync(activePath, 'utf8')) as ActiveScryModel
    }

    await openArchitectureTab(orcaPage)

    await seedEngineArchitectureModel(orcaPage, worktreePath, {
      nodes: [
        {
          id: 'system',
          data: { name: 'Shop', description: 'Commerce', kind: 'system' }
        },
        {
          id: 'api',
          parentId: 'system',
          data: {
            name: 'API',
            description: 'HTTP API',
            kind: 'container',
            status: 'implemented'
          }
        },
        {
          id: 'handler',
          parentId: 'api',
          data: {
            name: 'Handler',
            description: 'Request handler',
            kind: 'component',
            status: 'proposed'
          }
        }
      ],
      links: [],
      sourceMap: {},
      boundaries: { api: [{ pattern: 'src/index.ts' }] }
    })

    await expect(
      orcaPage.getByTestId('architecture-tree-node').filter({ hasText: 'API' })
    ).toBeVisible({ timeout: 10_000 })
    await expect
      .poll(() => readActiveScryModel().boundaries?.api?.[0], { timeout: 10_000 })
      .toMatchObject({ pattern: 'src/index.ts' })

    const shopTreeNode = orcaPage.getByTestId('architecture-tree-node').filter({ hasText: 'Shop' })
    await expect(shopTreeNode).toBeVisible({ timeout: 10_000 })
    await shopTreeNode.getByTestId('architecture-tree-drill-node').click({ force: true })
    await orcaPage.getByTestId('architecture-zoom-fit').click({ force: true })
    const apiCanvasNode = orcaPage.locator('[data-testid="architecture-node"][data-node-id="api"]')
    await expect(apiCanvasNode).toBeVisible({ timeout: 10_000 })
    const apiSourceLink = apiCanvasNode.getByTestId('architecture-source-link').filter({
      hasText: 'src/index.ts'
    })
    await expect(apiSourceLink).toBeVisible({ timeout: 10_000 })
    await apiSourceLink.click({ force: true })
    await expect
      .poll(async () => orcaPage.locator('.editor-header-path').first().textContent(), {
        timeout: 10_000
      })
      .toContain('src/index.ts')

    await activateArchitectureTab(orcaPage)
    await expect(orcaPage.getByTestId('architecture-sync-lock-toggle')).toBeVisible({
      timeout: 10_000
    })
    await orcaPage.getByTestId('architecture-sync-lock-toggle').click({ force: true })
    await expect
      .poll(() => existsSync(path.join(worktreePath, '.scryer', '.implementing')), {
        timeout: 5_000
      })
      .toBe(true)

    await orcaPage.getByTestId('architecture-sync-lock-toggle').click({ force: true })
    await expect
      .poll(() => existsSync(path.join(worktreePath, '.scryer', '.implementing')), {
        timeout: 5_000
      })
      .toBe(false)

    await orcaPage.evaluate(() => {
      window.__store?.setState((state) => ({
        settings: {
          ...state.settings,
          defaultTuiAgent: 'codex',
          agentCmdOverrides: {
            ...state.settings?.agentCmdOverrides,
            codex: 'node -e "setTimeout(()=>{},30000)"'
          }
        }
      }))
    })

    await activateArchitectureTab(orcaPage)
    const apiTreeNode = orcaPage.getByTestId('architecture-tree-node').filter({ hasText: 'API' })
    await expect(apiTreeNode).toBeVisible({ timeout: 10_000 })
    await apiTreeNode.getByTestId('architecture-tree-drill-node').click({ force: true })
    await expect
      .poll(() => readActiveScryModel().nodes?.some((node) => node.id === 'handler') ?? false, {
        timeout: 10_000
      })
      .toBe(true)
    const handlerTreeNode = orcaPage
      .getByTestId('architecture-tree-node')
      .filter({ hasText: 'Handler' })
    await handlerTreeNode.getByTestId('architecture-tree-drill-node').click({ force: true })
    await expect(orcaPage.getByTestId('architecture-code-level-rack')).toBeVisible({
      timeout: 10_000
    })
    await orcaPage.evaluate(async (projectPath) => {
      const result = await window.api.architecture.executeScryerOperation({
        projectPath,
        operationId: 'scryer.symbol.add',
        input: {
          items: [
            {
              parent_id: 'handler',
              name: 'handleRequest',
              source_file: 'src/index.ts',
              responsibilities: ['Handles requests']
            }
          ]
        }
      })
      if (!result.ok) {
        throw new Error(result.error.message)
      }
    }, worktreePath)
    await expect(orcaPage.getByTestId('architecture-node-name')).toHaveValue('handleRequest', {
      timeout: 10_000
    })
    await expect
      .poll(
        () => readActiveScryModel().nodes?.some((node) => node.name === 'handleRequest') ?? false,
        { timeout: 10_000 }
      )
      .toBe(true)
    await activateArchitectureTab(orcaPage)
    await closeOpenMenus(orcaPage)

    const startSyncButton = orcaPage.getByTestId('architecture-sync-start')
    await expect(startSyncButton).toBeVisible()
    await startSyncButton.press('Enter')
    await expect(orcaPage.locator('.xterm:visible').first()).toBeVisible({ timeout: 10_000 })
    await activateArchitectureTab(orcaPage)
    await expect(orcaPage.getByTestId('architecture-add-node')).toBeDisabled()

    await expect(
      orcaPage.evaluate(async (projectPath) => {
        const result = await window.api.architecture.executeScryerOperation({
          projectPath,
          operationId: 'scryer.node.update',
          input: { nodes: [{ node_id: 'api', name: 'Changed During Sync' }] }
        })
        if (result.ok) {
          throw new Error('Expected lease-protected write to fail')
        }
        throw new Error(result.error.message)
      }, worktreePath)
    ).rejects.toThrow(/lease/i)
    await expect
      .poll(() => readActiveScryModel().nodes?.find((node) => node.id === 'api')?.name, {
        timeout: 10_000
      })
      .toBe('API')

    await orcaPage.getByTestId('architecture-sync-cancel').click({ force: true })
    await expect
      .poll(() => readActiveScryModel().nodes?.find((node) => node.id === 'api')?.name, {
        timeout: 10_000
      })
      .toBe('API')
    await expect
      .poll(() => existsSync(path.join(worktreePath, '.scryer', '.implementing')), {
        timeout: 5_000
      })
      .toBe(false)
  })

  test('auto-finishes sync when the launched agent reports done', async ({ orcaPage }) => {
    const worktreePath = await getActiveWorktreePath(orcaPage)
    rmSync(path.join(worktreePath, '.scryer'), { recursive: true, force: true })

    await openArchitectureTab(orcaPage)
    await seedEngineArchitectureModel(orcaPage, worktreePath, {
      nodes: [
        {
          id: 'system',
          data: { name: 'Shop', description: 'Commerce', kind: 'system' }
        }
      ],
      links: []
    })
    await expect(
      orcaPage.getByTestId('architecture-tree-node').filter({ hasText: 'Shop' })
    ).toBeVisible({ timeout: 10_000 })

    await orcaPage.evaluate(() => {
      window.__store?.setState((state) => ({
        settings: {
          ...state.settings,
          defaultTuiAgent: 'codex',
          agentCmdOverrides: {
            ...state.settings?.agentCmdOverrides,
            codex: 'node -e "setTimeout(()=>{},30000)"'
          }
        }
      }))
    })

    const terminalIdsBeforeSync = await orcaPage.evaluate(() => {
      const state = window.__store?.getState()
      const activeWorktreeId = state?.activeWorktreeId
      return activeWorktreeId
        ? (state?.tabsByWorktree[activeWorktreeId] ?? []).map((tab) => tab.id)
        : []
    })
    await closeOpenMenus(orcaPage)
    const startSyncButton = orcaPage.getByTestId('architecture-sync-start')
    await expect(startSyncButton).toBeVisible()
    await startSyncButton.press('Enter')
    await expect(orcaPage.locator('.xterm:visible').first()).toBeVisible({ timeout: 10_000 })
    await expect
      .poll(
        async () =>
          orcaPage.evaluate((previousIds) => {
            const state = window.__store?.getState()
            const activeWorktreeId = state?.activeWorktreeId
            const tabs = activeWorktreeId ? (state?.tabsByWorktree[activeWorktreeId] ?? []) : []
            return tabs.find((tab) => !previousIds.includes(tab.id))?.id ?? null
          }, terminalIdsBeforeSync),
        { timeout: 10_000 }
      )
      .not.toBeNull()
    const syncTerminalTabId = await orcaPage.evaluate((previousIds) => {
      const state = window.__store?.getState()
      const activeWorktreeId = state?.activeWorktreeId
      const tabs = activeWorktreeId ? (state?.tabsByWorktree[activeWorktreeId] ?? []) : []
      return tabs.find((tab) => !previousIds.includes(tab.id))?.id ?? null
    }, terminalIdsBeforeSync)
    expect(syncTerminalTabId).not.toBeNull()
    await expect
      .poll(() => existsSync(path.join(worktreePath, '.scryer', '.implementing')), {
        timeout: 5_000
      })
      .toBe(true)
    await orcaPage.evaluate((tabId) => {
      window.__store?.getState().setAgentStatus(
        `${tabId}:0`,
        {
          state: 'done',
          prompt: 'Architecture sync',
          agentType: 'codex',
          lastAssistantMessage: 'sync complete'
        },
        '* Codex done',
        { updatedAt: Date.now() + 1_000, stateStartedAt: Date.now() + 1_000 }
      )
    }, syncTerminalTabId)
    await expect
      .poll(
        async () =>
          orcaPage.evaluate(
            async (projectPath) => window.api.architecture.isSyncing({ projectPath }),
            worktreePath
          ),
        { timeout: 15_000 }
      )
      .toBe(false)

    await activateArchitectureTab(orcaPage)
    await expect(orcaPage.getByTestId('architecture-add-node')).toBeEnabled({ timeout: 10_000 })
    expect(existsSync(path.join(worktreePath, '.scryer', 'model.baseline.scry'))).toBe(true)
  })

  test('restores architecture tabs and model state after a clean relaunch', async (// oxlint-disable-next-line no-empty-pattern -- Playwright's second fixture arg is testInfo; the first must be an object destructure to opt out of the default fixture set.
  {}, testInfo) => {
    const repoPath = readFileSync(TEST_REPO_PATH_FILE, 'utf-8').trim()
    if (!repoPath || !existsSync(repoPath)) {
      test.skip(true, 'Global setup did not produce a seeded test repo')
      return
    }

    const session = createRestartSession(testInfo)
    let firstApp: Awaited<ReturnType<typeof session.launch>>['app'] | null = null
    let secondApp: Awaited<ReturnType<typeof session.launch>>['app'] | null = null

    try {
      const firstLaunch = await session.launch()
      firstApp = firstLaunch.app
      const worktreeId = await attachRepoAndOpenTerminal(firstLaunch.page, repoPath)
      await waitForSessionReady(firstLaunch.page)
      const worktreePath = await firstLaunch.page.evaluate((id) => {
        const state = window.__store?.getState()
        const worktree = Object.values(state?.worktreesByRepo ?? {})
          .flat()
          .find((entry) => entry.id === id)
        if (!worktree) {
          throw new Error('worktree not found')
        }
        return worktree.path
      }, worktreeId)
      rmSync(path.join(worktreePath, '.scryer'), { recursive: true, force: true })

      await openArchitectureTab(firstLaunch.page)
      await firstLaunch.page.evaluate(async (worktreePath) => {
        await window.api.architecture.executeScryerOperation({
          projectPath: worktreePath,
          operationId: 'scryer.model.set',
          input: {
            data: {
              version: '0.3',
              nodes: [
                {
                  id: 'system',
                  kind: 'system',
                  name: 'Restart Shop',
                  description: 'Persisted architecture'
                }
              ],
              links: [],
              groups: [],
              sourceMap: {},
              boundaries: {}
            }
          }
        })
      }, worktreePath)

      await expect(firstLaunch.page.getByTestId('architecture-panel')).toBeVisible({
        timeout: 10_000
      })
      await expect
        .poll(
          () =>
            firstLaunch.page.evaluate(async (worktreeId) => {
              const session = await window.api.session.get()
              return {
                architectureTabCount: session.architectureTabsByWorktree?.[worktreeId]?.length ?? 0,
                activeArchitectureTabId:
                  session.activeArchitectureTabIdByWorktree?.[worktreeId] ?? null,
                unifiedArchitectureTabCount:
                  session.unifiedTabs?.[worktreeId]?.filter(
                    (tab) => tab.contentType === 'architecture'
                  ).length ?? 0,
                tabGroupCount: session.tabGroups?.[worktreeId]?.length ?? 0,
                activeGroupId: session.activeGroupIdByWorktree?.[worktreeId] ?? null
              }
            }, worktreeId),
          { timeout: 10_000 }
        )
        .toMatchObject({
          architectureTabCount: 1,
          activeArchitectureTabId: expect.any(String),
          unifiedArchitectureTabCount: 1,
          tabGroupCount: 1,
          activeGroupId: expect.any(String)
        })

      const persistedSessionPath = path.join(session.userDataDir, 'orca-data.json')
      await expect
        .poll(
          () => {
            const persisted = JSON.parse(readFileSync(persistedSessionPath, 'utf8'))
            const workspaceSession = persisted.workspaceSession ?? {}
            return {
              architectureTabCount:
                workspaceSession.architectureTabsByWorktree?.[worktreeId]?.length ?? 0,
              activeArchitectureTabId:
                workspaceSession.activeArchitectureTabIdByWorktree?.[worktreeId] ?? null,
              unifiedArchitectureTabCount:
                workspaceSession.unifiedTabs?.[worktreeId]?.filter(
                  (tab: { contentType?: string }) => tab.contentType === 'architecture'
                ).length ?? 0,
              tabGroupCount: workspaceSession.tabGroups?.[worktreeId]?.length ?? 0,
              activeGroupId: workspaceSession.activeGroupIdByWorktree?.[worktreeId] ?? null
            }
          },
          { timeout: 10_000 }
        )
        .toMatchObject({
          architectureTabCount: 1,
          activeArchitectureTabId: expect.any(String),
          unifiedArchitectureTabCount: 1,
          tabGroupCount: 1,
          activeGroupId: expect.any(String)
        })

      await session.close(firstApp)
      firstApp = null

      const secondLaunch = await session.launch()
      secondApp = secondLaunch.app
      await waitForSessionReady(secondLaunch.page)

      await expect
        .poll(
          () =>
            secondLaunch.page.evaluate(() => {
              const state = window.__store?.getState()
              return {
                activeWorktreeId: state?.activeWorktreeId ?? null,
                activeTabType: state?.activeTabType ?? null,
                architectureTabCount: Object.values(state?.architectureTabsByWorktree ?? {}).flat()
                  .length,
                unifiedArchitectureTabCount: Object.values(state?.unifiedTabsByWorktree ?? {})
                  .flat()
                  .filter((tab) => tab.contentType === 'architecture').length,
                activeArchitectureTabIdByWorktree: state?.activeArchitectureTabIdByWorktree ?? {},
                worktreeIds: Object.values(state?.worktreesByRepo ?? {})
                  .flat()
                  .map((entry) => entry.id)
              }
            }),
          { timeout: 5_000 }
        )
        .toMatchObject({
          architectureTabCount: 1,
          unifiedArchitectureTabCount: 1,
          activeTabType: 'architecture'
        })

      await expect(secondLaunch.page.getByTestId('architecture-panel')).toBeVisible({
        timeout: 10_000
      })
      await expect(
        secondLaunch.page.getByTestId('architecture-tree-node').filter({ hasText: 'Restart Shop' })
      ).toBeVisible({ timeout: 10_000 })
    } finally {
      if (secondApp) {
        await session.close(secondApp)
      }
      if (firstApp) {
        await session.close(firstApp)
      }
      session.dispose()
    }
  })
})
