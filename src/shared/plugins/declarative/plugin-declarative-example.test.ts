import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, expect, it } from 'vitest'
import { pluginDeclarativeRenderPayloadSchema } from './plugin-declarative-messages'
import { parsePluginDeclarativeTree } from './plugin-declarative-tree'

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..')
const RUNTIME = path.join(ROOT, 'resources', 'plugins', 'declarative', 'orca-runtime.mjs')
const EXAMPLE = path.join(ROOT, 'examples', 'plugins', 'hello-components', 'dist', 'panel.js')
const scratch = mkdtempSync(path.join(tmpdir(), 'orca-declarative-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

it('runs the prebuilt sample against the shipped guest runtime, like the guest import map would', async () => {
  // Why copies: a fresh module instance per test, with `orca` resolved the way the guest import map does.
  const runtimeCopy = path.join(scratch, 'orca-runtime.mjs')
  writeFileSync(runtimeCopy, readFileSync(RUNTIME))
  const runtimeUrl = pathToFileURL(runtimeCopy).href
  const panel = readFileSync(EXAMPLE, 'utf8').replace(
    /from "orca(?:\/jsx-runtime)?"/g,
    `from ${JSON.stringify(runtimeUrl)}`
  )
  const panelCopy = path.join(scratch, 'panel.mjs')
  writeFileSync(panelCopy, panel)

  const orca = await import(/* @vite-ignore */ runtimeUrl)
  const posted: { event: string; payload: { revision: number; tree: unknown } }[] = []
  const runtime = orca.installOrcaDeclarativeRuntime({
    post: (event: string, payload: { revision: number; tree: unknown }) =>
      posted.push({ event, payload }),
    bridge: null
  })
  await runtime.boot(await import(/* @vite-ignore */ pathToFileURL(panelCopy).href))
  const { document } = runtime

  const first = posted.at(-1)!.payload
  const parsed = parsePluginDeclarativeTree(first.tree)
  expect(parsed).toMatchObject({ ok: true, warnings: [] })
  expect(JSON.stringify(first.tree)).toContain(
    '{"type":"Badge","key":"#1","props":{"tone":"accent"},"children":["1"," open"]}'
  )

  const input = JSON.stringify(first.tree).match(/"Input".*?"onChange":\{"\$callback":"([^"]+)"/)
  expect(input).not.toBeNull()
  expect(
    runtime.dispatchEvent({
      document,
      revision: first.revision,
      callback: input![1],
      args: ['Ship it'],
      edit: 1
    })
  ).toBe(true)
  runtime.flush()
  const second = posted.at(-1)!.payload
  const submit = JSON.stringify(second.tree).match(/"onSubmit":\{"\$callback":"([^"]+)"/)
  expect(
    runtime.dispatchEvent({
      document,
      revision: second.revision,
      callback: submit![1],
      args: ['Ship it']
    })
  ).toBe(true)
  runtime.flush()
  const renders = posted.filter((entry) => entry.event === 'ui.render')
  expect(JSON.stringify(renders.at(-1)!.payload.tree)).toContain('Ship it')
  expect(parsePluginDeclarativeTree(renders.at(-1)!.payload.tree).ok).toBe(true)
  // The list is a persisted atom: the change goes to Orca for the next run.
  expect(posted.filter((entry) => entry.event === 'ui.persist')).toEqual([
    {
      event: 'ui.persist',
      payload: expect.objectContaining({
        entries: [expect.objectContaining({ scope: 'plugin', key: 'todos', version: 1 })]
      })
    }
  ])
  runtime.dispose()
})

// A missing named import is a link-time SyntaxError in real ES modules (checked with node); the
// test runner's module shim cannot show that, so this covers the documented fallback only.
it('draws a component created by name with h() as a placeholder when Orca does not know it', async () => {
  const runtimeCopy = path.join(scratch, 'orca-runtime-compat.mjs')
  writeFileSync(runtimeCopy, readFileSync(RUNTIME))
  const orca = await import(/* @vite-ignore */ pathToFileURL(runtimeCopy).href)
  const posted: unknown[] = []
  const runtime = orca.installOrcaDeclarativeRuntime({
    post: (_event: string, payload: unknown) => posted.push(payload),
    bridge: null
  })
  expect(orca.ui.catalog).toBeGreaterThanOrEqual(1)
  expect(orca.ui.has('Carousel')).toBe(false)
  runtime.mount(() => orca.h('Stack', null, orca.h('Carousel', { label: 'Shots' }), 'rest'))
  const tree = parsePluginDeclarativeTree(
    pluginDeclarativeRenderPayloadSchema.parse(posted.at(-1)).tree
  )
  expect(tree.ok && tree.tree?.children).toEqual([
    { type: 'Unsupported', key: '#0', props: { name: 'Carousel' }, children: [] },
    'rest'
  ])
})
