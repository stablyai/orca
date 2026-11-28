import { useEffect } from 'react'
import { toast } from 'sonner'
import { Toaster } from '@/components/ui/sonner'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import { showUploadProgressView, type UploadRow } from './upload-progress-toast'

const MB = 1024 * 1024
const noop = (): void => undefined
const NO_ACTIONS = { onCancelFile: noop, onCancelAll: noop, onDismiss: noop }

function ToastStage({
  title,
  rows,
  remainingMs
}: {
  title: string
  rows: UploadRow[]
  remainingMs: number | null
}): React.JSX.Element {
  useEffect(() => {
    showUploadProgressView('upload-progress-fixture', title, rows, remainingMs, NO_ACTIONS)
    return () => {
      toast.dismiss()
    }
  }, [title, rows, remainingMs])
  // A transform makes this frame the toaster's fixed-position containing block, like a 600px window.
  return (
    <div className="relative h-[360px] w-[600px] [transform:translateZ(0)]">
      <Toaster closeButton toastOptions={{ className: 'font-sans text-sm' }} />
    </div>
  )
}

// Toasts mount and animate in after the first paint; capture once they have.
async function toastMounted(): Promise<void> {
  const deadline = performance.now() + 3000
  while (!document.querySelector('[data-sonner-toast][data-mounted="true"]')) {
    if (performance.now() > deadline) {
      throw new Error('Timed out waiting for the toast')
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  await new Promise((resolve) => setTimeout(resolve, 400))
}

function uploadToast(title: string, rows: UploadRow[], remainingMs: number | null) {
  return defineFixture({
    width: 600,
    render: () => <ToastStage title={title} rows={rows} remainingMs={remainingMs} />,
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
