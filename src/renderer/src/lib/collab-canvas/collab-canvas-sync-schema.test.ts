/**
 * Structural regression for the useSync schema that crashed panel boards:
 * Migration 'com.tldraw.binding.arrow/1' depends on missing migration
 * 'com.tldraw.shape.arrow/4' when only AgentDraftShapeUtil was passed.
 *
 * Full createTLSchemaFromUtils is not exercised here: loading `tldraw` in vitest
 * pulls tiptap getStyleProperty (shimmed only in electron.vite). The shipped
 * helper + CollabCanvas wiring are asserted from source; runtime is dogfood.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))

describe('collab canvas sync schema wiring', () => {
  it('merges defaultShapeUtils + defaultBindingUtils with agent-draft', () => {
    const src = readFileSync(join(here, 'collab-canvas-sync-schema.ts'), 'utf8')
    expect(src).toContain('defaultShapeUtils')
    expect(src).toContain('defaultBindingUtils')
    expect(src).toContain('COLLAB_CANVAS_SHAPE_UTILS')
    expect(src).toMatch(/\[\s*\.\.\.defaultShapeUtils\s*,\s*\.\.\.COLLAB_CANVAS_SHAPE_UTILS\s*\]/)
  })

  it('CollabCanvas passes full schema utils into useSync and Tldraw', () => {
    const src = readFileSync(
      join(here, '../../components/collab-canvas/CollabCanvas.tsx'),
      'utf8'
    )
    expect(src).toContain('buildCollabCanvasSchemaUtils')
    expect(src).toContain('useSync({')
    expect(src).toContain('shapeUtils: collabSchemaUtils.shapeUtils')
    expect(src).toContain('bindingUtils: collabSchemaUtils.bindingUtils')
    // Must not pass custom-only utils (the bug that dropped arrow migrations).
    expect(src).not.toMatch(/useSync\(\{\s*uri,\s*assets,\s*shapeUtils:\s*COLLAB_CANVAS_SHAPE_UTILS/)
  })
})
