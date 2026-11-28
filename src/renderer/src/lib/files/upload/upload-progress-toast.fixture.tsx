import { defineFixture } from '../../../component-fixtures/component-fixture'
import { ToastFixtureStage, toastMounted } from '../../../component-fixtures/toast-fixture-stage'
import { showUploadProgressView, type UploadRow } from './upload-progress-toast'

const MB = 1024 * 1024
const noop = (): void => undefined
const NO_ACTIONS = { onCancelFile: noop, onCancelAll: noop, onDismiss: noop }

function uploadToast(title: string, rows: UploadRow[], remainingMs: number | null) {
  const show = (): void =>
    showUploadProgressView('upload-progress-fixture', title, rows, remainingMs, NO_ACTIONS)
  return defineFixture({
    width: 600,
    render: () => <ToastFixtureStage show={show} />,
    interact: toastMounted
  })
}

const recording = (sentMb: number): UploadRow => ({
  sourcePath: '/Users/sam/Movies/screen-recording.mov',
  name: 'screen-recording.mov',
  byteLength: 600 * MB,
  sent: sentMb * MB,
  status: 'uploading'
})

export const oneFileMinutesLeft = uploadToast(
  'Uploading 1 file to runtime…',
  [recording(274)],
  290_000
)

export const oneFileUnderAMinute = uploadToast(
  'Uploading 1 file to runtime…',
  [recording(560)],
  12_000
)

export const threeFiles = uploadToast(
  'Uploading 3 files to runtime…',
  [
    recording(274),
    {
      sourcePath: '/Users/sam/Movies/clip-60mb.mov',
      name: 'clip-60mb.mov',
      byteLength: 60 * MB,
      sent: 0,
      status: 'waiting'
    },
    {
      sourcePath: '/Users/sam/Documents/design-review-notes.pdf',
      name: 'design-review-notes.pdf',
      byteLength: 4.2 * MB,
      sent: 1.3 * MB,
      status: 'cancelled'
    }
  ],
  290_000
)
