import type { CDPSession } from '@stablyai/playwright-test'

let nextEvaluationId = 0

// Hidden Chromium targets have type "other", so Playwright does not expose a Page for them.
export async function evaluateHiddenBrowserPage(
  cdp: CDPSession,
  sessionId: string,
  expression: string
): Promise<void> {
  const id = ++nextEvaluationId
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('Hidden browser evaluation timed out')), 10_000)
    function finish(error?: Error) {
      clearTimeout(timer)
      cdp.off('Target.receivedMessageFromTarget', receive)
      if (error) {
        reject(error)
      } else {
        resolve()
      }
    }
    function receive(event: { sessionId: string; message: string }) {
      if (event.sessionId !== sessionId) {
        return
      }
      const response: unknown = JSON.parse(event.message)
      if (!response || typeof response !== 'object' || !('id' in response) || response.id !== id) {
        return
      }
      if ('error' in response) {
        finish(new Error(`Hidden browser protocol error: ${JSON.stringify(response.error)}`))
        return
      }
      if (
        'result' in response &&
        response.result &&
        typeof response.result === 'object' &&
        'exceptionDetails' in response.result
      ) {
        finish(
          new Error(
            `Hidden browser script failed: ${JSON.stringify(response.result.exceptionDetails)}`
          )
        )
        return
      }
      finish()
    }
    cdp.on('Target.receivedMessageFromTarget', receive)
    void cdp
      .send('Target.sendMessageToTarget', {
        sessionId,
        message: JSON.stringify({
          id,
          method: 'Runtime.evaluate',
          params: { expression, awaitPromise: true, userGesture: true }
        })
      })
      .catch(finish)
  })
}
