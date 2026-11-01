import { createCheckLogFixture } from '../../../../../config/scripts/check-job-log-test-fixture.mjs'
import { sliceCheckLogTail } from '../../../../shared/check-job-log-tail-slice'

export const capturedCheckLogFailure = createCheckLogFixture()

export const capturedCheckLogExcerpt = sliceCheckLogTail(capturedCheckLogFailure.rawLog)
export const capturedCheckLogFrame = capturedCheckLogExcerpt
  .split('\n')
  .find((line) => line.includes(capturedCheckLogFailure.expectedStackFrame))

if (!capturedCheckLogFrame) {
  throw new Error('Captured check log is missing its expected complete frame')
}
