import type { Page } from '@stablyai/playwright-test'

export async function callDispatchShowFromTrustedRenderer<TDispatch>(
  page: Page,
  taskId: string
): Promise<{ result: { dispatch: TDispatch | null } }> {
  const response = await page.evaluate(
    async (task) =>
      window.api.runtime.call({
        method: 'orchestration.dispatchShow',
        params: { task }
      }),
    taskId
  )
  if (!response.ok) {
    throw new Error(`${response.error.code}: ${response.error.message}`)
  }
  return response as typeof response & { result: { dispatch: TDispatch | null } }
}
