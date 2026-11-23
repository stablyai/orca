import { useState } from 'react'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import { PortalContainerContext } from '../../ui/portal-container-context'
import { base } from '../bot-connectors-host-fixture'
import { GoogleHostChoiceDialog } from './GoogleHostChoiceDialog'

// Connect Google, open. The dialog is fixed, so it portals into a transformed box: 480 shows its
// own 448 cap, 340 is the narrowest it gets, which it fills. 220 stands in for the smallest window at
// the largest zoom, where the footer wraps.
const LONG_NAME = 'Orchestration builder for the whole team'
let bridge: typeof window.api.googleSetup

function Stage({ width, name }: { width: 480 | 340 | 220; name: string }): React.JSX.Element {
  const [box, setBox] = useState<HTMLElement | null>(null)
  return (
    <div ref={setBox} className="relative h-[460px] translate-x-0 bg-background" style={{ width }}>
      {box ? (
        <PortalContainerContext.Provider value={box}>
          <GoogleHostChoiceDialog bot={{ ...base, name }} open onOpenChange={() => {}} />
        </PortalContainerContext.Provider>
      ) : null}
    </div>
  )
}

function hostChoiceFixture(
  width: 480 | 340 | 220,
  options?: { name?: string; importError?: true }
) {
  return defineFixture({
    width: width + 32,
    setup: options?.importError
      ? () => {
          bridge = window.api.googleSetup
          Reflect.set(window.api, 'googleSetup', {
            ...bridge,
            pickClientFile: async () => ({
              ok: false,
              message: 'This file isn’t a Google app file. Download it again from Google Cloud.'
            })
          })
        }
      : undefined,
    // Why restore: the explorer page stays warm, so the failing picker would leak into later fixtures.
    interact: options?.importError
      ? async () => {
          const button = [...document.querySelectorAll('button')].find(
            (candidate) => candidate.textContent === 'Import file'
          )
          button?.click()
          await new Promise((resolve) => setTimeout(resolve, 50))
          Reflect.set(window.api, 'googleSetup', bridge)
        }
      : undefined,
    render: () => <Stage width={width} name={options?.name ?? 'CoS'} />
  })
}

export const wide = hostChoiceFixture(480)

export const narrow = hostChoiceFixture(340)

export const narrowLongName = hostChoiceFixture(340, { name: LONG_NAME })

export const importError = hostChoiceFixture(480, { importError: true })

export const narrowImportError = hostChoiceFixture(340, { importError: true })

export const crampedImportError = hostChoiceFixture(220, { importError: true })
