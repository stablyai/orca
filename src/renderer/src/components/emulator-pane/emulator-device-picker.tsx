import { useState } from 'react'
import { Check, ChevronDown, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { translate } from '@/i18n/i18n'
import type { SimulatorDeviceRow } from './emulator-pane-types'
import { emulatorDeviceDescription, groupEmulatorDevices } from './emulator-device-picker-groups'

type Props = {
  devices: SimulatorDeviceRow[]
  selectedUdid: string | null
  disabled?: boolean
  onSelectDevice: (id: string) => void
}

export function EmulatorDevicePicker({ devices, selectedUdid, disabled, onSelectDevice }: Props) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [otherOpen, setOtherOpen] = useState(false)
  const [unavailableOpen, setUnavailableOpen] = useState(false)
  const groups = groupEmulatorDevices(devices, selectedUdid)
  const selected = devices.find((device) => device.udid === selectedUdid)
  const chooseLabel = translate('emulator.picker.choose', 'Choose emulator')
  const duplicateKeys = new Map<string, number>()
  for (const device of devices) {
    const key = `${device.name} ${emulatorDeviceDescription(device)}`
    duplicateKeys.set(key, (duplicateKeys.get(key) ?? 0) + 1)
  }
  const renderDevice = (device: SimulatorDeviceRow) => {
    const description = emulatorDeviceDescription(device)
    const duplicate = (duplicateKeys.get(`${device.name} ${description}`) ?? 0) > 1
    const status =
      device.state === 'Booted'
        ? translate('emulator.picker.running', 'Running')
        : device.state === 'Booting'
          ? translate('emulator.picker.starting', 'Starting')
          : translate('emulator.picker.stopped', 'Stopped')
    return (
      <CommandItem
        key={device.udid}
        value={device.udid}
        keywords={[device.name, description, device.udid, device.availabilityError ?? '']}
        disabled={device.isAvailable === false}
        selection="palette"
        data-current={device.udid === selectedUdid || undefined}
        onSelect={() => {
          onSelectDevice(device.udid)
          setOpen(false)
        }}
      >
        <div className="min-w-0 flex-1">
          <div className="truncate">{device.name}</div>
          <div className="text-xs text-muted-foreground">
            {[description, status, duplicate ? device.udid.slice(0, 8) : '']
              .filter(Boolean)
              .join(' · ')}
          </div>
          {device.isAvailable === false && (
            <div className="text-xs text-muted-foreground">
              {device.availabilityError ||
                translate('emulator.picker.runtimeUnavailable', 'Runtime unavailable')}
            </div>
          )}
        </div>
        {device.udid === selectedUdid && <Check className="size-4 shrink-0" />}
      </CommandItem>
    )
  }
  return (
    <Popover
      open={open}
      onOpenChange={(value) => {
        setOpen(value)
        if (!value) {
          setSearch('')
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="xs"
          role="combobox"
          aria-expanded={open}
          aria-label={chooseLabel}
          disabled={disabled || devices.length === 0}
          className="h-7 w-56 justify-between"
        >
          <span className="truncate">
            {selected ? `${selected.name} · ${emulatorDeviceDescription(selected)}` : chooseLabel}
          </span>
          <ChevronDown className="size-3.5 shrink-0" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 max-w-[calc(100vw-2rem)]" wheelScroll>
        <Command density="menu">
          <CommandInput
            value={search}
            onValueChange={setSearch}
            placeholder={translate('emulator.picker.search', 'Search devices…')}
          />
          <CommandList className="max-h-80">
            <CommandEmpty>{translate('emulator.picker.empty', 'No matching devices')}</CommandEmpty>
            {groups.used.length > 0 && (
              <CommandGroup heading={translate('emulator.picker.used', 'Used devices')}>
                {groups.used.map(renderDevice)}
              </CommandGroup>
            )}
            {groups.other.length > 0 && (
              <CommandGroup>
                {!search && (
                  <CommandItem
                    value="other-devices"
                    onSelect={() => setOtherOpen(!otherOpen)}
                    aria-expanded={otherOpen}
                    selection="palette"
                  >
                    <ChevronRight className={otherOpen ? 'rotate-90' : ''} />
                    {translate('emulator.picker.other', 'Other devices on this computer')} (
                    {groups.other.length})
                  </CommandItem>
                )}
                {(search || otherOpen) && groups.other.map(renderDevice)}
              </CommandGroup>
            )}
            {groups.unavailable.length > 0 && (
              <CommandGroup>
                {!search && (
                  <CommandItem
                    value="unavailable-devices"
                    onSelect={() => setUnavailableOpen(!unavailableOpen)}
                    aria-expanded={unavailableOpen}
                    selection="palette"
                  >
                    <ChevronRight className={unavailableOpen ? 'rotate-90' : ''} />
                    {translate('emulator.picker.unavailable', 'Unavailable runtimes')} (
                    {groups.unavailable.length})
                  </CommandItem>
                )}
                {(search || unavailableOpen) && groups.unavailable.map(renderDevice)}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
