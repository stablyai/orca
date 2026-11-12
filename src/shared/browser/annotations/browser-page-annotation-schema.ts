import { z } from 'zod'
import type { BrowserPageAnnotation } from '../element-grab/browser-grab-types'

const rectSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number()
})

const payloadSchema = z.object({
  page: z.object({
    sanitizedUrl: z.string(),
    title: z.string(),
    viewportWidth: z.number(),
    viewportHeight: z.number(),
    scrollX: z.number(),
    scrollY: z.number(),
    devicePixelRatio: z.number(),
    capturedAt: z.string()
  }),
  target: z.object({
    tagName: z.string(),
    selector: z.string(),
    elementPath: z.string().optional(),
    fullPath: z.string().optional(),
    cssClasses: z.string().optional(),
    nearbyElements: z.array(z.string()).optional(),
    selectedText: z.string().nullable().optional(),
    isFixed: z.boolean().optional(),
    reactComponents: z.string().nullable().optional(),
    sourceFile: z.string().nullable().optional(),
    textSnippet: z.string(),
    htmlSnippet: z.string(),
    attributes: z.record(z.string(), z.string()),
    accessibility: z.object({
      role: z.string().nullable(),
      accessibleName: z.string().nullable(),
      ariaLabel: z.string().nullable(),
      ariaLabelledBy: z.string().nullable()
    }),
    rectViewport: rectSchema,
    rectPage: rectSchema,
    computedStyles: z.object({
      display: z.string(),
      position: z.string(),
      width: z.string(),
      height: z.string(),
      margin: z.string(),
      padding: z.string(),
      color: z.string(),
      backgroundColor: z.string(),
      border: z.string(),
      borderRadius: z.string(),
      fontFamily: z.string(),
      fontSize: z.string(),
      fontWeight: z.string(),
      lineHeight: z.string(),
      textAlign: z.string(),
      zIndex: z.string()
    })
  }),
  nearbyText: z.array(z.string()),
  ancestorPath: z.array(z.string()),
  screenshot: z.null().catch(null)
})

export const browserPageAnnotationSchema: z.ZodType<BrowserPageAnnotation> = z.object({
  id: z.string(),
  browserPageId: z.string(),
  comment: z.string(),
  intent: z.enum(['fix', 'change', 'question', 'approve']),
  priority: z.enum(['blocking', 'important', 'suggestion']),
  createdAt: z.string(),
  payload: payloadSchema,
  imagePaths: z.array(z.string()).optional()
})
