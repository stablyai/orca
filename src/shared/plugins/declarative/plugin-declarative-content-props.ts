import { z } from 'zod'
import { PLUGIN_DECLARATIVE_LIMITS as LIMITS } from './plugin-declarative-limits'
import {
  PLUGIN_RELATIVE_TIME_FORMATS,
  pluginRelativeTimeAt
} from './plugin-declarative-relative-time'
import {
  component,
  flag,
  icon,
  label,
  maxHeight,
  requiredLabel,
  tone
} from './plugin-declarative-prop-schemas'

/** Content and feedback components added in catalog 2 (Orca 1.4.247). */

const documentText = z.string().max(LIMITS.maxDocumentLength)

// The formats Orca checks from their header before any decoder runs (plugin-image-format.ts).
const IMAGE_EXTENSION = /\.(?:png|jpe?g|webp)$/i

/** A file inside the plugin: relative, `/`-separated, no `.`/`..` segments, never a URL. */
export function isPluginDeclarativeImagePath(path: string): boolean {
  return (
    IMAGE_EXTENSION.test(path) &&
    !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(path) &&
    !/[\\\0?#]/.test(path) &&
    path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..')
  )
}

const markdownProps = z.object({ content: documentText }).strict()
const codeViewProps = z
  .object({
    code: documentText,
    /** A language id Orca highlights (built in or from a syntax plugin); unknown ones stay plain. */
    language: z
      .string()
      .regex(/^[A-Za-z0-9_+#.-]{1,64}$/)
      .optional(),
    label: label.optional(),
    lineNumbers: flag,
    wrap: flag,
    maxHeight
  })
  .strict()
const imageProps = z
  .object({
    src: z
      .string()
      .max(512)
      .refine(isPluginDeclarativeImagePath, 'must be an image file in the plugin'),
    /** Empty for a purely decorative image. */
    alt: label,
    size: z.enum(['xs', 'sm', 'md', 'lg', 'full']).optional(),
    fit: z.enum(['contain', 'cover']).optional(),
    rounded: flag
  })
  .strict()
const keyValueProps = z
  .object({
    label: label.optional(),
    items: z
      .array(
        z
          .object({
            label: requiredLabel,
            value: z.union([label, z.number().refine(Number.isFinite), z.boolean(), z.null()]),
            tone,
            code: flag
          })
          .strict()
      )
      .max(LIMITS.maxKeyValueItems)
  })
  .strict()
const calloutProps = z.object({ tone, title: label.optional(), icon: icon.optional() }).strict()
const relativeTimeProps = z
  .object({
    /** Milliseconds since the epoch (`Date.now()`); Orca keeps the words current. */
    at: pluginRelativeTimeAt,
    format: z.enum(PLUGIN_RELATIVE_TIME_FORMATS).optional(),
    tone,
    muted: flag
  })
  .strict()
const skeletonProps = z
  .object({
    shape: z.enum(['text', 'block', 'circle']).optional(),
    lines: z.number().int().min(1).max(10).optional(),
    label: label.optional()
  })
  .strict()

export const PLUGIN_DECLARATIVE_CONTENT_CATALOG = {
  Markdown: component(markdownProps, 'none'),
  CodeView: component(codeViewProps, 'none'),
  Image: component(imageProps, 'none'),
  KeyValue: component(keyValueProps, 'none'),
  Callout: component(calloutProps, 'any'),
  Skeleton: component(skeletonProps, 'none'),
  RelativeTime: component(relativeTimeProps, 'none')
} as const
