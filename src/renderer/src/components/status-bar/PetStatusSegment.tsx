import React from 'react'
import { PackageOpen, Trash2, Upload } from 'lucide-react'
import { toast } from 'sonner'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useAppStore } from '../../store'
import { PetFromImageDialog } from '../pet/PetFromImageDialog'
import { BUNDLED_PET, BUNDLED_PETS, findBundledPet, isBundledPetId } from '../pet/pet-models'
import { PET_SIZE_MAX, PET_SIZE_MIN } from '../../../../shared/pet-types'
import { translate } from '@/i18n/i18n'

// Why: cluster pet-related controls (show/hide, character picker, custom
// upload + removal, jump-to-settings) behind a single status-bar segment. Only
// rendered when experimentalPet is on (gated by the caller). Pet
// visibility is independently tracked so users can dismiss without having to
// find the experimental flag again.
function PetStatusSegmentInner(): React.JSX.Element {
  const petVisible = useAppStore((s) => s.petVisible)
  const setPetVisible = useAppStore((s) => s.setPetVisible)
  const petId = useAppStore((s) => s.petId)
  const setPetId = useAppStore((s) => s.setPetId)
  const customPets = useAppStore((s) => s.customPets)
  const addCustomPet = useAppStore((s) => s.addCustomPet)
  const removeCustomPet = useAppStore((s) => s.removeCustomPet)
  const petSize = useAppStore((s) => s.petSize)
  const setPetSize = useAppStore((s) => s.setPetSize)
  const petWalks = useAppStore((s) => s.petWalks)
  const setPetWalks = useAppStore((s) => s.setPetWalks)
  const petReturnsToLane = useAppStore((s) => s.petReturnsToLane)
  const setPetReturnsToLane = useAppStore((s) => s.setPetReturnsToLane)
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)

  const [fromImageOpen, setFromImageOpen] = React.useState(false)

  const bundled = isBundledPetId(petId)
  const activeBundled = bundled ? (findBundledPet(petId) ?? BUNDLED_PET) : null
  const activeCustom = bundled ? null : customPets.find((m) => m.id === petId)
  const activeLabel = activeBundled ? activeBundled.label : (activeCustom?.label ?? 'Pet')
  const label = petVisible ? activeLabel : `${activeLabel} hidden`

  const handleImport = async (): Promise<void> => {
    if (!window.api?.pet?.import) {
      console.warn('[pet-overlay] upload: window.api.pet.import missing — restart Orca')
      toast.error(
        translate(
          'auto.components.status.bar.PetStatusSegment.e6234bcc17',
          'Custom pet upload needs a full app restart (not just reload).'
        )
      )
      return
    }
    try {
      const model = await window.api.pet.import()
      if (!model) {
        return
      }
      addCustomPet(model)
      if (!petVisible) {
        setPetVisible(true)
      }
      setPetId(model.id)
    } catch (error) {
      console.error('[pet-overlay] upload: error', error)
      toast.error(
        error instanceof Error
          ? error.message
          : translate(
              'auto.components.status.bar.PetStatusSegment.f395c9a685',
              'Failed to import file'
            )
      )
    }
  }

  const choosePet = (id: string): void => {
    if (!petVisible) {
      setPetVisible(true)
    }
    setPetId(id)
  }

  const handleGeneratedPet = (model: Parameters<typeof addCustomPet>[0]): void => {
    addCustomPet(model)
    if (!petVisible) {
      setPetVisible(true)
    }
    setPetId(model.id)
  }

  const handleImportPetBundle = async (): Promise<void> => {
    if (!window.api?.pet?.importPetBundle) {
      toast.error(
        translate(
          'auto.components.status.bar.PetStatusSegment.2021d4f6db',
          'Pet bundle import needs a full app restart (not just reload).'
        )
      )
      return
    }
    try {
      const model = await window.api.pet.importPetBundle()
      if (!model) {
        return
      }
      addCustomPet(model)
      if (!petVisible) {
        setPetVisible(true)
      }
      setPetId(model.id)
    } catch (error) {
      console.error('[pet-overlay] pet bundle: error', error)
      toast.error(
        error instanceof Error
          ? error.message
          : translate(
              'auto.components.status.bar.PetStatusSegment.cef0ab4636',
              'Failed to import pet bundle'
            )
      )
    }
  }

  return (
    <>
      <PetFromImageDialog
        open={fromImageOpen}
        onOpenChange={setFromImageOpen}
        onCreated={handleGeneratedPet}
      />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="group inline-flex items-center cursor-pointer pl-1 pr-[6.5rem] py-0.5"
            aria-label={translate(
              'auto.components.status.bar.PetStatusSegment.aec479308a',
              'Pet menu'
            )}
          >
            <span
              className={`rounded px-1 py-0.5 text-[11px] font-medium text-muted-foreground group-hover:bg-accent/70 group-hover:text-foreground ${petVisible ? '' : 'opacity-50'}`}
            >
              {label}
            </span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="end" sideOffset={8} className="min-w-[220px]">
          <DropdownMenuLabel>
            {translate('auto.components.status.bar.PetStatusSegment.34c25dfe9c', 'Pet')}
          </DropdownMenuLabel>
          <DropdownMenuItem
            onSelect={(event) => {
              event.preventDefault()
              setPetVisible(!petVisible)
            }}
          >
            {petVisible
              ? translate('auto.components.status.bar.PetStatusSegment.1fbc51cc77', 'Hide pet')
              : translate('auto.components.status.bar.PetStatusSegment.6d0a8cd179', 'Show pet')}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {/* Why: checked items rather than a toggling label — both settings are
            on by default, so the state shows at a glance. The primitive carries
            aria-checked; a hand-drawn tick announces nothing. */}
          <DropdownMenuCheckboxItem
            checked={petWalks}
            onCheckedChange={setPetWalks}
            onSelect={(event) => event.preventDefault()}
          >
            {translate('auto.components.status.bar.PetStatusSegment.petWalks', 'Walk around')}
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem
            checked={petReturnsToLane}
            onCheckedChange={setPetReturnsToLane}
            onSelect={(event) => event.preventDefault()}
          >
            {translate(
              'auto.components.status.bar.PetStatusSegment.petReturnsToLane',
              'Drop to the floor when released'
            )}
          </DropdownMenuCheckboxItem>
          <DropdownMenuSeparator />
          {/* Why: in-menu range so users can resize the overlay without leaving
            the dropdown — pet sprites can import larger than the default 180px
            box and visually overwhelm the viewport. preventDefault on pointer
            events stops Radix from closing the menu while the user drags. */}
          <div
            className="px-2 py-1.5"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            <div className="mb-1 flex items-center justify-between text-[11px] text-muted-foreground">
              <span>
                {translate('auto.components.status.bar.PetStatusSegment.2f7bbaa457', 'Size')}
              </span>
              <span className="tabular-nums">
                {petSize}
                {translate('auto.components.status.bar.PetStatusSegment.c6aa805b1b', 'px')}
              </span>
            </div>
            <input
              type="range"
              min={PET_SIZE_MIN}
              max={PET_SIZE_MAX}
              step={10}
              value={petSize}
              onChange={(e) => setPetSize(Number(e.target.value))}
              className="w-full"
              aria-label={translate(
                'auto.components.status.bar.PetStatusSegment.b75484a01a',
                'Pet size'
              )}
            />
          </div>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              {translate('auto.components.status.bar.PetStatusSegment.0608ad02a2', 'Choose pet')}
            </DropdownMenuSubTrigger>
            {/* Why: portal so the submenu escapes the parent Content's overflow
              clipping — without this, the submenu opens inside the scroll
              container and gets clipped. Matches the convention used in
              BrowserToolbarMenu/BrowserProfileRow. */}
            <DropdownMenuPortal>
              <DropdownMenuSubContent className="min-w-[220px]">
                {/* Why: one radio group over both lists — picking a pet is a
                  single choice, so the primitive should say so rather than a
                  tick drawn per row. */}
                <DropdownMenuRadioGroup value={petId} onValueChange={choosePet}>
                  {BUNDLED_PETS.map((pet) => (
                    <DropdownMenuRadioItem key={pet.id} value={pet.id}>
                      {pet.label}
                    </DropdownMenuRadioItem>
                  ))}
                  {customPets.length > 0 ? <DropdownMenuSeparator /> : null}
                  {customPets.map((model) => (
                    <DropdownMenuRadioItem key={model.id} value={model.id}>
                      <span className="flex-1 truncate">{model.label}</span>
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={() => {
                    // Why: let the menu close naturally (no preventDefault) before
                    // invoking the native file picker. Keeping the menu open when
                    // the OS dialog opens caused the dialog to appear behind the
                    // dropdown overlay on macOS.
                    void handleImport()
                  }}
                >
                  <Upload className="size-3.5" aria-hidden />
                  {translate(
                    'auto.components.status.bar.PetStatusSegment.59b5955621',
                    'Upload your own…'
                  )}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => {
                    void handleImportPetBundle()
                  }}
                >
                  <PackageOpen className="size-3.5" aria-hidden />
                  {translate(
                    'auto.components.status.bar.PetStatusSegment.ed176ad68f',
                    'Import .codex-pet bundle…'
                  )}
                </DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuPortal>
          </DropdownMenuSub>
          {/* Why: removal is its own entry rather than a trash button riding the
            row it removes — a button inside a role="menuitem" is invalid, and
            the arrow keys that drive the menu never reach it. */}
          {customPets.length > 0 ? (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                {translate(
                  'auto.components.status.bar.PetStatusSegment.removeAPet',
                  'Remove a pet'
                )}
              </DropdownMenuSubTrigger>
              <DropdownMenuPortal>
                <DropdownMenuSubContent className="min-w-[220px]">
                  {customPets.map((model) => (
                    <DropdownMenuItem
                      key={model.id}
                      variant="destructive"
                      onSelect={() => removeCustomPet(model.id)}
                    >
                      <Trash2 className="size-3.5" aria-hidden />
                      <span className="flex-1 truncate">
                        {translate(
                          'auto.components.status.bar.PetStatusSegment.3668339495',
                          'Remove {{value0}}',
                          { value0: model.label }
                        )}
                      </span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuPortal>
            </DropdownMenuSub>
          ) : null}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => {
              // Why: no preventDefault here, unlike the toggles above. Holding
              // the menu open behind the dialog leaves it open once the dialog
              // closes, so the next click on the trigger toggles it shut and the
              // menu reads as broken.
              setFromImageOpen(true)
            }}
          >
            {translate(
              'auto.components.status.bar.PetStatusSegment.createFromImage',
              'Create pet from image…'
            )}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              openSettingsTarget({
                pane: 'experimental',
                repoId: null,
                sectionId: 'experimental-pet'
              })
              openSettingsPage()
            }}
          >
            {translate('auto.components.status.bar.PetStatusSegment.cd8c6c654c', 'Pet settings…')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )
}

export const PetStatusSegment = React.memo(PetStatusSegmentInner)
