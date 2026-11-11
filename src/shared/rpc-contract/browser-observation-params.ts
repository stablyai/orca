import { z } from 'zod'
import {
  BrowserTarget,
  OptionalBoolean,
  OptionalPositiveInt,
  OptionalString
} from './rpc-param-primitives'

export const Snapshot = BrowserTarget.extend({
  interactive: OptionalBoolean,
  compact: OptionalBoolean,
  depth: OptionalPositiveInt,
  selector: OptionalString,
  urls: OptionalBoolean,
  delta: OptionalBoolean,
  full: OptionalBoolean
})

type BrowserTargetFields = keyof z.infer<typeof BrowserTarget>

export type BrowserSnapshotOptions = Omit<z.infer<typeof Snapshot>, BrowserTargetFields>

export const Screenshot = BrowserTarget.extend({
  format: z
    .unknown()
    .transform((v) => (v === 'png' || v === 'jpeg' ? v : undefined))
    .pipe(z.union([z.enum(['png', 'jpeg']), z.undefined()]))
    .optional(),
  ifChanged: OptionalBoolean,
  annotate: OptionalBoolean
})

export type BrowserScreenshotOptions = Omit<z.infer<typeof Screenshot>, BrowserTargetFields>
