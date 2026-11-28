import * as z from 'zod'
import { lazyZodSchema } from '../schema/lazy-zod-schema'

export const tabContentTypeSchema = lazyZodSchema(() =>
  z.enum([
    'terminal',
    'editor',
    'diff',
    'conflict-review',
    'check-details',
    'git-graph',
    'agent-session',
    'browser',
    'simulator',
    'room'
  ])
)

export const workspaceVisibleTabTypeSchema = lazyZodSchema(() =>
  z.enum(['terminal', 'editor', 'agent-session', 'browser', 'simulator'])
)
