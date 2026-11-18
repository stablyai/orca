import { z } from 'zod'
import {
  align,
  component,
  flag,
  gap,
  PLUGIN_DECLARATIVE_TONES
} from './plugin-declarative-prop-schemas'

/** Largest pixel size a Box accepts; bigger sizes would only push the panel off screen. */
export const PLUGIN_BOX_MAX_PX = 4096

// Why only px and whole percents: no `calc()`, `vh` or other CSS reaches the renderer.
const length = z
  .union([z.number().min(0).max(PLUGIN_BOX_MAX_PX), z.string().regex(/^(100|[1-9]?[0-9])%$/)])
  .optional()

export const PLUGIN_BOX_BACKGROUNDS = [
  'none',
  'muted',
  'card',
  ...PLUGIN_DECLARATIVE_TONES
] as const

const boxProps = z
  .object({
    direction: z.enum(['row', 'column']).optional(),
    gap,
    padding: gap,
    paddingX: gap,
    paddingY: gap,
    margin: gap,
    align,
    justify: z.enum(['start', 'center', 'end', 'between']).optional(),
    wrap: flag,
    grow: flag,
    shrink: flag,
    width: length,
    height: length,
    minWidth: length,
    minHeight: length,
    maxWidth: length,
    maxHeight: length,
    /** Lays children out in this many equal columns instead of a row or column. */
    columns: z.number().int().min(1).max(6).optional(),
    scroll: z.enum(['x', 'y', 'both']).optional(),
    border: z.union([z.boolean(), z.enum(PLUGIN_DECLARATIVE_TONES)]).optional(),
    radius: z.enum(['none', 'sm', 'md', 'lg', 'full']).optional(),
    background: z.enum(PLUGIN_BOX_BACKGROUNDS).optional()
  })
  .strict()

/** Catalog 4 (Orca 1.4.248): a general layout container, styled only through tokens. */
export const PLUGIN_DECLARATIVE_BOX_CATALOG = { Box: component(boxProps, 'any') } as const
