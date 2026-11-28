import React, { Suspense, type ComponentProps } from 'react'
import { lazyWithRetry as lazy } from '@/app-shell/startup/lazy-with-retry'
import type { NewBotDialog } from './NewBotDialog'
import type { ImportBotDialog } from './ImportBotDialog'
import type { BotGroupMembersDialog } from './BotGroupMembersDialog'
import type { AddConnectorDialog } from './AddConnectorDialog'

const NewBotDialogImpl = lazy(() =>
  import('./NewBotDialog').then((module) => ({ default: module.NewBotDialog }))
)
const ImportBotDialogImpl = lazy(() =>
  import('./ImportBotDialog').then((module) => ({ default: module.ImportBotDialog }))
)
const BotGroupMembersDialogImpl = lazy(() =>
  import('./BotGroupMembersDialog').then((module) => ({ default: module.BotGroupMembersDialog }))
)
const AddConnectorDialogImpl = lazy(() =>
  import('./AddConnectorDialog').then((module) => ({ default: module.AddConnectorDialog }))
)

export function LazyNewBotDialog(props: ComponentProps<typeof NewBotDialog>): React.JSX.Element {
  return (
    <Suspense fallback={null}>
      <NewBotDialogImpl {...props} />
    </Suspense>
  )
}

export function LazyImportBotDialog(
  props: ComponentProps<typeof ImportBotDialog>
): React.JSX.Element {
  return (
    <Suspense fallback={null}>
      <ImportBotDialogImpl {...props} />
    </Suspense>
  )
}

export function LazyBotGroupMembersDialog(
  props: ComponentProps<typeof BotGroupMembersDialog>
): React.JSX.Element {
  return (
    <Suspense fallback={null}>
      <BotGroupMembersDialogImpl {...props} />
    </Suspense>
  )
}

export function LazyAddConnectorDialog(
  props: ComponentProps<typeof AddConnectorDialog>
): React.JSX.Element {
  return (
    <Suspense fallback={null}>
      <AddConnectorDialogImpl {...props} />
    </Suspense>
  )
}
