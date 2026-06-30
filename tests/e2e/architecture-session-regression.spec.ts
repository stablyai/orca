import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import path from 'path'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

type SavedModel = {
  version: '0.3'
  nodes: {
    id: string
    kind: string
    name: string
    description?: string
    parentId?: string
  }[]
  links: { id: string; src: string; dst: string; label: string }[]
  groups: { id: string; name: string; memberIds: string[]; parentGroupId?: string }[]
  sourceMap: Record<string, unknown>
  boundaries: Record<string, unknown>
}

type SeedModel = {
  nodes?: Record<string, unknown>[]
  links?: Record<string, unknown>[]
  edges?: Record<string, unknown>[]
  groups?: Record<string, unknown>[]
  sourceMap?: Record<string, unknown>
  boundaries?: Record<string, unknown>
}

async function getActiveWorktreePath(page: Page): Promise<string> {
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

async function openArchitectureTab(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'New tab' }).click({ force: true })
  const newArchitectureItem = page.getByRole('menuitem', { name: /New Architecture/i }).first()
  await expect(newArchitectureItem).toBeVisible({ timeout: 10_000 })
  await newArchitectureItem.click({ force: true })
  await expect(page.getByTestId('architecture-panel')).toBeVisible({ timeout: 30_000 })
}

async function seedModel(page: Page, projectPath: string, model: SavedModel): Promise<void> {
  const result = await page.evaluate(
    async ({ nextProjectPath, nextModel }) => {
      const inputModel = nextModel as SeedModel
      const data = {
        version: '0.3',
        nodes: (inputModel.nodes ?? []).map((node) => {
          const nodeData = (node.data ?? node) as Record<string, unknown>
          return {
            id: String(node.id),
            kind: String(nodeData.kind ?? 'system'),
            name: String(nodeData.name ?? node.id),
            ...(node.parentId ? { parentId: String(node.parentId) } : {}),
            ...(typeof nodeData.description === 'string'
              ? { description: nodeData.description }
              : {})
          }
        }),
        links: (inputModel.links ?? inputModel.edges ?? []).map((link) => {
          const linkData = (link.data ?? link) as Record<string, unknown>
          return {
            id: String(link.id),
            src: String(link.src ?? link.source),
            dst: String(link.dst ?? link.target),
            label: String(linkData.label ?? '')
          }
        }),
        groups: (inputModel.groups ?? []).map((group) => ({
          id: String(group.id),
          name: String(group.name ?? group.id),
          memberIds: Array.isArray(group.memberIds)
            ? group.memberIds.filter((member): member is string => typeof member === 'string')
            : [],
          ...(typeof group.parentGroupId === 'string' ? { parentGroupId: group.parentGroupId } : {})
        })),
        sourceMap: inputModel.sourceMap ?? {},
        boundaries: inputModel.boundaries ?? {}
      }
      return window.api.architecture.executeScryerOperation({
        projectPath: nextProjectPath,
        operationId: 'scryer.model.set',
        input: { data }
      })
    },
    { nextProjectPath: projectPath, nextModel: model }
  )
  expect(result).toMatchObject({ ok: true })
}

function getModelPath(projectPath: string): string {
  return path.join(projectPath, '.scryer', 'model.scry')
}

function getActiveModelPath(projectPath: string): string {
  const plannedPath = path.join(projectPath, '.scryer', 'planned.scry')
  return existsSync(plannedPath) ? plannedPath : getModelPath(projectPath)
}

function readSavedModel(projectPath: string): SavedModel {
  return JSON.parse(readFileSync(getActiveModelPath(projectPath), 'utf8'))
}

async function terminalTabCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const state = window.__store?.getState()
    const activeWorktreeId = state?.activeWorktreeId
    return activeWorktreeId ? (state.tabsByWorktree[activeWorktreeId] ?? []).length : 0
  })
}

test.describe('Architecture model session regressions', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
  })

  test('merges a node field save with an external model edit made while the input is focused', async ({
    orcaPage
  }) => {
    const worktreePath = await getActiveWorktreePath(orcaPage)
    rmSync(path.join(worktreePath, '.scryer'), { recursive: true, force: true })
    await openArchitectureTab(orcaPage)
    await seedModel(orcaPage, worktreePath, {
      nodes: [
        {
          id: 'api',
          kind: 'system',
          name: 'API',
          description: 'Initial description'
        }
      ],
      links: [],
      groups: [],
      sourceMap: {},
      boundaries: {}
    })
    await expect(orcaPage.getByTestId('architecture-node-name')).toHaveValue('API')

    const nameInput = orcaPage.getByTestId('architecture-node-name')
    await nameInput.focus()
    await nameInput.fill('API Local Draft')

    const externallyEdited = readSavedModel(worktreePath)
    externallyEdited.nodes[0]!.description = 'External editor description'
    writeFileSync(
      getActiveModelPath(worktreePath),
      `${JSON.stringify(externallyEdited, null, 2)}\n`
    )

    await orcaPage.keyboard.press('Tab')

    await expect
      .poll(() => readSavedModel(worktreePath).nodes[0]?.name, { timeout: 5_000 })
      .toBe('API Local Draft')
    expect(readSavedModel(worktreePath).nodes[0]?.description).toBe('External editor description')
  })

  test('guards Build with AI against rapid duplicate launches', async ({ orcaPage }) => {
    const worktreePath = await getActiveWorktreePath(orcaPage)
    rmSync(path.join(worktreePath, '.scryer'), { recursive: true, force: true })
    await orcaPage.evaluate(() => {
      window.__store?.setState((state) => ({
        settings: {
          ...state.settings,
          defaultTuiAgent: 'codex',
          agentCmdOverrides: {
            ...state.settings?.agentCmdOverrides,
            codex: 'node -e "setTimeout(()=>process.exit(1),200)"'
          }
        }
      }))
    })
    await openArchitectureTab(orcaPage)
    await expect(orcaPage.getByTestId('architecture-build-ai')).toBeVisible({ timeout: 10_000 })
    const before = await terminalTabCount(orcaPage)

    await orcaPage.getByTestId('architecture-build-ai').dblclick({ force: true })

    await expect
      .poll(async () => terminalTabCount(orcaPage), { timeout: 10_000 })
      .toBeGreaterThan(before)
    expect(await terminalTabCount(orcaPage)).toBe(before + 1)
  })

  test('opens a dirty model with warnings instead of blanking the architecture panel', async ({
    orcaPage
  }) => {
    const worktreePath = await getActiveWorktreePath(orcaPage)
    rmSync(path.join(worktreePath, '.scryer'), { recursive: true, force: true })
    const modelDir = path.join(worktreePath, '.scryer')
    const modelPath = getModelPath(worktreePath)
    mkdirSync(modelDir, { recursive: true })
    const dirtyModel = {
      version: '0.3',
      nodes: [
        {
          id: 'api',
          kind: 'container',
          name: 'API',
          description: 'Calls @[Ghost API]'
        }
      ],
      links: [{ id: 'link-api-ghost', src: 'api', dst: 'ghost', label: 'calls' }],
      sourceMap: {
        api: [{ pattern: ' src/api.ts ', line: 9, endLine: 2 }],
        ghost: [{ pattern: 'src/ghost.ts' }]
      },
      groups: [{ id: 'backend', name: 'Backend', memberIds: ['api', 'ghost'] }],
      boundaries: {}
    }
    expect(modelDir).toBe(path.dirname(modelPath))
    writeFileSync(modelPath, `${JSON.stringify(dirtyModel, null, 2)}\n`)

    await openArchitectureTab(orcaPage)

    await expect(orcaPage.getByTestId('architecture-panel')).toBeVisible({ timeout: 30_000 })
    await expect(orcaPage.getByTestId('architecture-model-warning')).toContainText('model warning')
    await expect(
      orcaPage.getByTestId('architecture-node-title').filter({ hasText: 'API' })
    ).toBeVisible()
  })
})
