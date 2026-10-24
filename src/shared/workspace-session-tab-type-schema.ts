import { z } from 'zod'
import { LIVE_SURFACE_CONTENT_TYPES } from './tab-types'

export const tabContentTypeSchema = z.enum([
  'terminal',
  'editor',
  'diff',
  'conflict-review',
  'check-details',
  'agent-session',
  'browser',
  ...LIVE_SURFACE_CONTENT_TYPES
])

export const workspaceVisibleTabTypeSchema = z.enum([
  'terminal',
  'editor',
  'agent-session',
  'browser',
  ...LIVE_SURFACE_CONTENT_TYPES
])
