import type { ElectronApplication } from '@stablyai/playwright-test'
import type { KaneoTask } from '../../../src/shared/kaneo-types'

export const KANEO_TASK: KaneoTask = {
  siteUrl: 'https://tasks.example.com',
  workspaceId: 'workspace-1',
  projectId: 'project-1',
  taskId: 'task-42',
  url: 'https://tasks.example.com/dashboard/workspace/workspace-1/project/project-1/task/task-42',
  title: 'Improve booking confirmation',
  description: 'Show the reservation reference and confirm the selected tee time.',
  number: 42,
  status: 'todo'
}

export async function installKaneoApiFixture(app: ElectronApplication): Promise<void> {
  // Keep IPC, credentials, validation and runtime RPC real; replace only the provider HTTP boundary.
  await app.evaluate(({ net }, task) => {
    const originalFetch = net.fetch.bind(net)
    let attempts = 0
    net.fetch = async (input, options) => {
      const url = new URL(String(input))
      if (url.origin !== task.siteUrl) {
        return originalFetch(input, options)
      }
      if (new Headers(options?.headers).get('Authorization') !== 'Bearer fixture-api-key') {
        return new Response('Invalid fixture key', { status: 401 })
      }
      if (url.pathname === '/api/auth/organization/list') {
        return Response.json([{ id: task.workspaceId }])
      }
      if (url.pathname === '/api/project') {
        return Response.json([{ id: task.projectId, workspaceId: task.workspaceId }])
      }
      if (url.pathname === `/api/task/${task.taskId}`) {
        attempts += 1
        await new Promise((resolve) => setTimeout(resolve, 1200))
        return attempts === 1
          ? new Response('', { status: 429 })
          : Response.json({ ...task, id: task.taskId })
      }
      return new Response('', { status: 404 })
    }
  }, KANEO_TASK)
}
