// The store's host-status entry is one shape, and every reader of the map has to accept exactly
// it. A narrower local copy still typechecks against the store — the fields it is missing are all
// optional — so it freezes at the vintage it was written at and never fails. #17710 added
// `remoteControl` and #20003 added `snapshot`; the copies these assertions cover were not updated
// either time. Like the other typed-contract tests, they fail at typecheck, not at runtime.
import { describe, expectTypeOf, it } from 'vitest'
import type { buildExecutionHostRegistry } from '../../../../shared/execution-host-registry'
import type { buildSidebarHostOptions } from '@/components/sidebar/sidebar-host-options'
import type { getRuntimeAutomationAvailability } from '@/components/automations/automation-target-availability'
import type { getRuntimeSourceHostAvailability } from '@/components/automations/automation-source-context'
import type { AutomationListLocalRowProps } from '@/components/automations/AutomationListLocalRow'
import type { AutomationsListPanelProps } from '@/components/automations/AutomationsListPanel'
import type { RuntimeEnvironmentStatus } from './runtime-status-types'

// Compare the entry each reader accepts rather than the surrounding map, so a mismatch names the
// field that drifted instead of every ReadonlyMap method signature.
type AcceptedEntry<T> = NonNullable<T> extends ReadonlyMap<string, infer TEntry> ? TEntry : never

type RegistryEntry = AcceptedEntry<
  Parameters<typeof buildExecutionHostRegistry>[0]['runtimeStatusByEnvironmentId']
>
type SidebarEntry = AcceptedEntry<
  Parameters<typeof buildSidebarHostOptions>[0]['runtimeStatusByEnvironmentId']
>
type AutomationEntry = AcceptedEntry<Parameters<typeof getRuntimeAutomationAvailability>[1]>
type SourceContextEntry = AcceptedEntry<Parameters<typeof getRuntimeSourceHostAvailability>[1]>
type LocalRowEntry = AcceptedEntry<AutomationListLocalRowProps['runtimeStatusByEnvironmentId']>
type ListPanelEntry = AcceptedEntry<AutomationsListPanelProps['runtimeStatusByEnvironmentId']>

describe('every reader of the runtime host status map accepts the store entry', () => {
  it('holds for the execution-host registry', () => {
    expectTypeOf<RegistryEntry>().toEqualTypeOf<RuntimeEnvironmentStatus>()
  })

  it('holds for the sidebar host options', () => {
    expectTypeOf<SidebarEntry>().toEqualTypeOf<RuntimeEnvironmentStatus>()
  })

  it('holds for runtime automation availability', () => {
    expectTypeOf<AutomationEntry>().toEqualTypeOf<RuntimeEnvironmentStatus>()
  })

  // These three only forward the map, which is exactly how a stale copy survives: nothing they
  // do with it can fail, so the drift surfaces in whatever they hand it to.
  it('holds for the automation source-context reader', () => {
    expectTypeOf<SourceContextEntry>().toEqualTypeOf<RuntimeEnvironmentStatus>()
  })

  it('holds for the automation list row', () => {
    expectTypeOf<LocalRowEntry>().toEqualTypeOf<RuntimeEnvironmentStatus>()
  })

  it('holds for the automations list panel', () => {
    expectTypeOf<ListPanelEntry>().toEqualTypeOf<RuntimeEnvironmentStatus>()
  })
})
