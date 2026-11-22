import { defineFixture } from '../../component-fixtures/component-fixture'
import { stubBots } from '../../component-fixtures/fixture-bots'
import multiResolutionIcnsUrl from './__fixtures__/multi-resolution.icns?url'
import { NewBotDialog } from './NewBotDialog'

export const selected = defineFixture({
  width: 560,
  setup: () => stubBots([]),
  render: () => (
    <div className="h-[640px]">
      <NewBotDialog
        open
        onOpenChange={() => {}}
        initialName="ICNS Preview"
        proposal={{ name: 'ICNS Preview', purpose: '', mascot: 'D1' }}
      />
    </div>
  ),
  interact: async () => {
    document.querySelector<HTMLButtonElement>('button[aria-label="Change picture"]')?.click()
    await new Promise((resolve) => setTimeout(resolve, 100))
    const source = await fetch(multiResolutionIcnsUrl)
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!
    const transfer = new DataTransfer()
    transfer.items.add(
      new File([await source.arrayBuffer()], 'custom.icns', {
        type: 'application/octet-stream'
      })
    )
    input.files = transfer.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 350))
    const preview = document.querySelector<HTMLImageElement>(
      'button[aria-label="Change picture"] img'
    )
    if (!preview?.src.startsWith('data:image/png;base64,')) {
      throw new Error('ICNS selection did not reach the bot picture preview')
    }
    const decoded = await createImageBitmap(await (await fetch(preview.src)).blob())
    if (decoded.width !== 512 || decoded.height !== 512) {
      throw new Error('ICNS preview is not the existing 512 px square PNG')
    }
    decoded.close()
  }
})
