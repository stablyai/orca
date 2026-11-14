import { FrameDecoder as SharedFrameDecoder } from '../../../shared/relay-frame-decoder'
import type {
  DecodedFrame,
  FrameDecoderOptions
} from '../../../shared/relay-frame-decoder-contract'

// Default faults to stderr because standalone relays have no renderer to surface them.
export class FrameDecoder extends SharedFrameDecoder {
  constructor(
    onFrame: (frame: DecodedFrame) => void,
    onError?: (err: Error) => void,
    options: FrameDecoderOptions = {}
  ) {
    super(
      onFrame,
      onError ?? ((error) => process.stderr.write(`[relay] ${error.message}\n`)),
      options
    )
  }
}
