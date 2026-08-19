import { DEFAULT_PET_ID, GREMLIN_PET_ID, OPENCODE_PET_ID, type BundledPetId } from './pet-models'

/** A limb the pose composer cuts out and moves. `box` is the cut rectangle in
 *  frame coordinates, `pivot` the joint it swings about. */
export type PetLegRig = {
  box: readonly [x0: number, y0: number, x1: number, y1: number]
  pivot: readonly [x: number, y: number]
  /** Set on exactly one leg: the pets are drawn front-on with each foot splayed
   *  outward, so one is mirrored to make both face the walking direction. */
  mirror?: boolean
}

/** Everything the pose composer needs to animate one pet, measured by hand
 *  against its artwork. Shared by the bundled-sheet generator and the
 *  image-to-pet pipeline, so the two can never drift apart. */
export type PetRig = {
  frame: { width: number; height: number }
  legs: readonly [PetLegRig, PetLegRig]
  /** Slot the uploaded artwork drops into for the head-swap mode. */
  head: readonly [x0: number, y0: number, x1: number, y1: number]
  walk: {
    swingDeg: number
    bobPx: number
    liftPx: number
    /** Pulls the idle stance in; the pets stand far wider than anyone walks. */
    narrowPx: number
    /** How far the legs converge past each other on the contact frames. */
    crossPx: number
  }
  /** Vertical scale taken off the body at the bottom of the breath. */
  idleBreathe: number
  hopPx: number
  /** Heel-pivot angle for the impatient toe tap. */
  waitTapDeg: number
}

export const BUNDLED_PET_RIGS: Record<BundledPetId, PetRig> = {
  [DEFAULT_PET_ID]: {
    frame: { width: 320, height: 180 },
    legs: [
      { box: [130, 152, 164, 180], pivot: [150, 152], mirror: true },
      { box: [164, 152, 198, 180], pivot: [180, 152] }
    ],
    head: [118, 28, 212, 108],
    // Why: smaller amplitudes throughout — Claudino is drawn tiny inside a wide
    // canvas, so the same pixel swing reads far larger on him than on the others.
    walk: { swingDeg: 6, bobPx: 2, liftPx: 3, narrowPx: 3, crossPx: 7 },
    idleBreathe: 0.035,
    hopPx: 14,
    waitTapDeg: 14
  },
  [OPENCODE_PET_ID]: {
    frame: { width: 252, height: 320 },
    legs: [
      { box: [78, 238, 133, 292], pivot: [110, 236], mirror: true },
      { box: [133, 238, 194, 292], pivot: [150, 236] }
    ],
    head: [76, 20, 180, 142],
    walk: { swingDeg: 6, bobPx: 3, liftPx: 4, narrowPx: 5, crossPx: 13 },
    idleBreathe: 0.03,
    hopPx: 26,
    waitTapDeg: 12
  },
  [GREMLIN_PET_ID]: {
    frame: { width: 252, height: 320 },
    legs: [
      { box: [66, 247, 138, 300], pivot: [104, 245], mirror: true },
      { box: [138, 247, 208, 300], pivot: [156, 245] }
    ],
    head: [72, 28, 202, 168],
    walk: { swingDeg: 6, bobPx: 3, liftPx: 4, narrowPx: 6, crossPx: 13 },
    idleBreathe: 0.03,
    hopPx: 26,
    waitTapDeg: 12
  }
}

/** Undefined for anything that is not a bundled pet — imported `.codex-pet`
 *  bundles bring their own frames and are never composed from a rig. */
export function petRigFor(id: string): PetRig | undefined {
  return BUNDLED_PET_RIGS[id as BundledPetId]
}
