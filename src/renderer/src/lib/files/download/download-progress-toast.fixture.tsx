import { defineFixture } from '../../../component-fixtures/component-fixture'
import { ToastFixtureStage, toastMounted } from '../../../component-fixtures/toast-fixture-stage'
import { showDownloadProgressView } from './download-progress-toast'

const MB = 1024 * 1024
const noop = (): void => undefined
const NO_ACTIONS = { onCancel: noop, onDismiss: noop }

function downloadToast(receivedMb: number, totalMb: number | null, remainingMs: number | null) {
  const show = (): void =>
    showDownloadProgressView(
      'download-progress-fixture',
      'build-artifacts.tar.gz',
      receivedMb * MB,
      totalMb === null ? null : totalMb * MB,
      remainingMs,
      NO_ACTIONS
    )
  return defineFixture({
    width: 600,
    render: () => <ToastFixtureStage show={show} />,
    interact: toastMounted
  })
}

export const minutesLeft = downloadToast(274, 600, 290_000)

export const warmingUp = downloadToast(3, 600, null)

export const sizeUnknown = downloadToast(274, null, null)
