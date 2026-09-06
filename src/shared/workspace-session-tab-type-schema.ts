import { z } from 'zod'

export const tabContentTypeSchema = z.enum([
  'canvas',
  'terminal',
  'editor',
  'diff',
  'conflict-review',
  'check-details',
  'agent-session',
  'browser',
  'simulator'
])

export const workspaceVisibleTabTypeSchema = z.enum([
  'canvas',
  'terminal',
  'editor',
  'agent-session',
  'browser',
  'simulator'
])
