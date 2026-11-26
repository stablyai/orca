import { defineFixture } from '../../../component-fixtures/component-fixture'
import { UploadProgressCard } from './upload-progress-toast'

const TITLE = 'Uploading 2 files to runtime…'
const MB = 1024 * 1024
const noop = (): void => undefined

export const starting = defineFixture({
  width: 416,
  render: () => (
    <UploadProgressCard
      title={TITLE}
      sent={0}
      total={0}
      remainingMs={null}
      onHide={noop}
      onCancel={noop}
    />
  )
})

export const minutesLeft = defineFixture({
  width: 416,
  render: () => (
    <UploadProgressCard
      title={TITLE}
      sent={19.1 * MB}
      total={600 * MB}
      remainingMs={110_000}
      onHide={noop}
      onCancel={noop}
    />
  )
})

export const underAMinute = defineFixture({
  width: 416,
  render: () => (
    <UploadProgressCard
      title={TITLE}
      sent={560 * MB}
      total={600 * MB}
      remainingMs={12_000}
      onHide={noop}
      onCancel={noop}
    />
  )
})
