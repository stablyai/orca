/**
 * Schema utils for collab-canvas multiplayer stores (useSync + Tldraw).
 *
 * Must include tldraw defaults + agent-draft. Passing only custom utils to
 * createTLSchemaFromUtils drops arrow migrations while binding.arrow still
 * depends on them → StoreSchema throws at mount.
 */
import { defaultBindingUtils, defaultShapeUtils, type TLAnyBindingUtilConstructor } from 'tldraw'
import { COLLAB_CANVAS_SHAPE_UTILS } from './agent-draft-shape-util'

export type CollabCanvasSchemaUtils = {
  shapeUtils: Array<(typeof defaultShapeUtils)[number] | (typeof COLLAB_CANVAS_SHAPE_UTILS)[number]>
  bindingUtils: TLAnyBindingUtilConstructor[]
}

export function buildCollabCanvasSchemaUtils(): CollabCanvasSchemaUtils {
  return {
    shapeUtils: [...defaultShapeUtils, ...COLLAB_CANVAS_SHAPE_UTILS],
    bindingUtils: [...defaultBindingUtils]
  }
}
