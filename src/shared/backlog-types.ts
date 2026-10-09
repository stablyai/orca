import { z } from 'zod'

export const BACKLOG_CLI_VERSION = '1.48.0'
// Execution includes scanning and the 30-second CLI; transports leave room for cleanup.
export const BACKLOG_OPERATION_TIMEOUT_MS = 45000
export const BACKLOG_RELAY_TIMEOUT_MS = 55000
export const BACKLOG_RPC_TIMEOUT_MS = 65000
export const BACKLOG_CAPABILITY_TIMEOUT_MS = 5000

const TaskId = z
  .string()
  .regex(/^[a-zA-Z]+-[a-zA-Z0-9]+(?:[._-][a-zA-Z0-9]+)*$/)
  .max(128)
const Text = z
  .string()
  .max(65536)
  .refine((value) => !value.includes('\0'))
export const BacklogOperation = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('list'),
    search: z.string().max(200).default(''),
    status: z.string().max(200).default(''),
    offset: z.number().int().min(0).max(10000).default(0)
  }),
  z.object({ kind: z.literal('read'), id: TaskId }),
  z.object({
    kind: z.literal('create'),
    title: Text.min(1).max(1024),
    description: Text,
    status: z.string().min(1).max(200)
  }),
  z.object({
    kind: z.literal('edit'),
    id: TaskId,
    title: Text.min(1).max(1024),
    description: Text,
    status: z.string().min(1).max(200)
  })
])
export type BacklogOperation = z.infer<typeof BacklogOperation>
export type BacklogTask = {
  id: string
  title: string
  status: string
  description: string
  body: string
}
export type BacklogTaskSummary = Pick<BacklogTask, 'id' | 'title' | 'status'>
export type BacklogList = {
  projectPath: string
  projectName: string
  statuses: string[]
  tasks: BacklogTaskSummary[]
  total: number
  mutationUnavailable: string | null
}
export const BacklogReply = z.union([
  z.object({
    projectPath: z.string(),
    projectName: z.string(),
    statuses: z.array(z.string()),
    tasks: z.array(z.object({ id: TaskId, title: z.string(), status: z.string() })),
    total: z.number(),
    mutationUnavailable: z.string().nullable()
  }),
  z.object({
    id: TaskId,
    title: z.string(),
    status: z.string(),
    description: z.string(),
    body: z.string()
  }),
  z.object({ saved: z.literal(true) })
])
export type BacklogReply = z.infer<typeof BacklogReply>
